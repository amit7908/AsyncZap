import { Types } from 'mongoose';
import { AsyncZapQueue } from '../core/AsyncZapQueue';
import { JobOptions, JobDocument } from '../types';

export interface WorkflowNodeInput {
    job: string;
    payload?: any;
    options?: JobOptions;
    dependsOn?: string[]; // Node keys that must complete before this job runs
}

export type WorkflowDefinition = Record<string, WorkflowNodeInput>;

/**
 * Handles building and enqueuing Directed Acyclic Graph (DAG) workflows.
 */
export class WorkflowEngine {
    private queue: AsyncZapQueue;

    constructor(queue: AsyncZapQueue) {
        this.queue = queue;
    }

    /**
     * Builds and inserts a complete workflow.
     * PERF-03: Batches inserts by partition using insertBulk + Promise.all.
     */
    async createWorkflow(definition: WorkflowDefinition): Promise<Record<string, JobDocument>> {
        const nodeKeys = Object.keys(definition);

        // QA-05: Cycle detection before any DB insertion
        const hasCycle = (node: string, visited: Set<string>, stack: Set<string>): boolean => {
            visited.add(node); stack.add(node);
            for (const dep of definition[node]?.dependsOn || []) {
                if (!visited.has(dep) && hasCycle(dep, visited, stack)) return true;
                if (stack.has(dep)) return true;
            }
            stack.delete(node); return false;
        };
        const visited = new Set<string>();
        for (const key of nodeKeys) {
            if (!visited.has(key) && hasCycle(key, visited, new Set<string>())) {
                throw new Error(`Workflow Error: Cycle detected involving node '${key}'`);
            }
        }
        
        // 1. Assign ObjectIds to all nodes up front
        const idMap = new Map<string, Types.ObjectId>();
        for (const key of nodeKeys) {
            idMap.set(key, new Types.ObjectId());
        }

        // 2. Resolve dependencies and prepare documents grouped by partition
        const partitionManager = this.queue.getPartitionManager();
        const adapter = this.queue.getAdapter();
        const partitionBuckets = new Map<number, Array<{ key: string; doc: Partial<JobDocument> }>>();

        for (const [nodeKey, nodeInput] of Object.entries(definition)) {
            const tempId = idMap.get(nodeKey)!;
            const dependencies: Types.ObjectId[] = [];
            let remainingDependencies = 0;

            if (nodeInput.dependsOn && nodeInput.dependsOn.length > 0) {
                for (const depKey of nodeInput.dependsOn) {
                    if (!idMap.has(depKey)) {
                        throw new Error(`Workflow Error: Node '${nodeKey}' depends on non-existent node '${depKey}'.`);
                    }
                    dependencies.push(idMap.get(depKey)!);
                }
                remainingDependencies = dependencies.length;
            }

            const partitionId = partitionManager.getPartitionFor(nodeInput.job);
            const jobDoc: Partial<JobDocument> = {
                _id: tempId,
                name: nodeInput.job,
                payload: nodeInput.payload || {},
                status: 'pending',
                priority: nodeInput.options?.priority || 0,
                maxAttempts: nodeInput.options?.maxAttempts || 3,
                attempts: 0,
                runAt: nodeInput.options?.delay ? new Date(Date.now() + nodeInput.options.delay) : new Date(),
                dependencies,
                remainingDependencies
            };

            if (!partitionBuckets.has(partitionId)) {
                partitionBuckets.set(partitionId, []);
            }
            partitionBuckets.get(partitionId)!.push({ key: nodeKey, doc: jobDoc });
        }

        // 3. Bulk insert per partition in parallel
        const createdJobsMap: Record<string, JobDocument> = {};

        await Promise.all(
            Array.from(partitionBuckets.entries()).map(async ([pId, items]) => {
                const docs = items.map(item => item.doc);
                const inserted = await adapter.insertBulk(pId, docs);
                // Map results back by pre-assigned _id
                for (const item of items) {
                    const found = inserted.find((j: JobDocument) => j._id.toString() === item.doc._id!.toString());
                    if (found) createdJobsMap[item.key] = found;
                }
            })
        );

        return createdJobsMap;
    }

    /**
     * Resumes a stalled/failed workflow node by its original Job ID.
     * PERF-06: Uses Promise.all for parallel partition scanning.
     */
    async resumeNode(jobId: string | Types.ObjectId, newPayload?: any): Promise<boolean> {
        const adapter = this.queue.getAdapter();
        const partitionManager = this.queue.getPartitionManager();

        // PERF-06: Scan all partitions in parallel instead of sequentially
        const counts = partitionManager.getPartitionCount();
        const scanPromises = [];
        for (let pId = 0; pId < counts; pId++) {
            scanPromises.push(
                (async () => {
                    const model = adapter.getPartitionModel(pId);
                    const job = await model.findById(jobId).lean().exec();
                    return job ? { job, partitionId: pId } : null;
                })()
            );
        }

        const results = await Promise.all(scanPromises);
        const found = results.find(r => r !== null);

        if (found) {
            const { job: foundJob, partitionId: foundPartition } = found;
            const model = adapter.getPartitionModel(foundPartition);
            const updates: any = {
                status: 'pending',
                attempts: 0,
                runAt: new Date(),
                error: null,
                lockedAt: null,
                workerId: null
            };
            
            if (newPayload !== undefined) {
                updates.payload = newPayload;
            }

            await model.updateOne({ _id: jobId }, { $set: updates });
            return true;
        }

        // Check DLQ if missing
        const dlqModel = adapter.getDLQModel();
        const dlqJob: any = await dlqModel.findOne({ originalJobId: jobId }).lean().exec();

        if (dlqJob) {
            const foundPartition = dlqJob.partitionId;
            const model = adapter.getPartitionModel(foundPartition);
            
            const recoveredDoc = {
                _id: dlqJob.originalJobId,
                name: dlqJob.name,
                payload: newPayload !== undefined ? newPayload : dlqJob.payload,
                status: 'pending',
                priority: 0,
                maxAttempts: 3,
                attempts: 0,
                runAt: new Date(),
                dependencies: [],
                remainingDependencies: 0
            };
            
            await model.create(recoveredDoc);
            await dlqModel.deleteOne({ _id: dlqJob._id });
            return true;
        }

        throw new Error(`Workflow Recovery Error: Job ID ${jobId} not found in any partition or DLQ.`);
    }
}
