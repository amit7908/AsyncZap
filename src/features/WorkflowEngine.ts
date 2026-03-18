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
     * Evaluates dependencies and automatically links ObjectIds.
     * 
     * @param definition A key-value map defining the steps and their dependencies.
     * @returns A map of the created jobs (NodeKey -> JobDocument).
     */
    async createWorkflow(definition: WorkflowDefinition): Promise<Record<string, JobDocument>> {
        const nodeKeys = Object.keys(definition);
        
        // 1. Assign ObjectIds to all nodes up front before inserting
        // This allows us to link dependencies in a single DB pass.
        const idMap = new Map<string, Types.ObjectId>();
        for (const key of nodeKeys) {
            idMap.set(key, new Types.ObjectId());
        }

        const buildPayloads: Array<{ name: string; payload: any; tempId: Types.ObjectId; options: JobOptions; dependencies: Types.ObjectId[]; remainingDependencies: number }> = [];

        // 2. Resolve dependencies and prepare documents
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

            buildPayloads.push({
                name: nodeInput.job,
                payload: nodeInput.payload || {},
                options: nodeInput.options || {},
                tempId,
                dependencies,
                remainingDependencies
            });
        }

        // 3. Delegate to the queue's Bulk add logic (extended to support predefined IDs and DAG fields)
        const createdJobsMap: Record<string, JobDocument> = {};
        
        // Use the queue's adapter directly to insert these highly customized DAG nodes
        // (AsyncZapQueue.addBulk is too simplified for full DAG fields in Phase 1)
        const partitionManager = (this.queue as any).partitionManager;
        const adapter = (this.queue as any).adapter;

        for (let i = 0; i < buildPayloads.length; i++) {
            const input = buildPayloads[i];
            const originalKey = nodeKeys[i];
            
            const partitionId = partitionManager.getPartitionFor(input.name);
            const jobDoc: Partial<JobDocument> = {
                _id: input.tempId, // Force ObjectId
                name: input.name,
                payload: input.payload,
                status: 'pending',
                priority: input.options.priority || 0,
                maxAttempts: input.options.maxAttempts || 3,
                attempts: 0,
                runAt: input.options.delay ? new Date(Date.now() + input.options.delay) : new Date(),
                dependencies: input.dependencies,
                remainingDependencies: input.remainingDependencies
            };

            const inserted = await adapter.insertJob(partitionId, jobDoc);
            createdJobsMap[originalKey] = inserted;
        }

        return createdJobsMap;
    }

    /**
     * Resumes a stalled/failed workflow node by its original Job ID.
     * Optionally injects a new payload before resetting its status.
     * 
     * @param jobId The precise DB document _id of the failed job node
     * @param newPayload Optional adjusted payload to overwrite the bad data
     */
    async resumeNode(jobId: string | Types.ObjectId, newPayload?: any): Promise<boolean> {
        const adapter = (this.queue as any).adapter;
        const partitionManager = (this.queue as any).partitionManager;

        let foundJob = null;
        let foundPartition = -1;
        
        const counts = partitionManager.getPartitionCount();
        for (let pId = 0; pId < counts; pId++) {
            const model = adapter.getPartitionModel(pId);
            const job = await model.findById(jobId).lean().exec();
            if (job) {
                foundJob = job;
                foundPartition = pId;
                break;
            }
        }

        if (foundJob) {
            // Job was found in normal partition (likely status: 'failed')
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
        const dlqJob = await dlqModel.findOne({ originalJobId: jobId }).lean().exec();

        if (dlqJob) {
            // Move back from DLQ
            foundPartition = dlqJob.partitionId;
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
