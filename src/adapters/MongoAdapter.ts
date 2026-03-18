import { Connection, Model, Types } from 'mongoose';
import { JobSchema } from '../models/JobModel';
import { JobDocument } from '../types';

/**
 * Adapter specifically for integrating AsyncZap with MongoDB via Mongoose.
 * Manages dynamically creating models for partition collections
 * (e.g., asynczap_jobs_0, asynczap_jobs_1...).
 */
export class MongoAdapter {
    private connection: Connection;
    private models: Map<number, Model<JobDocument>> = new Map();

    constructor(connection: Connection) {
        this.connection = connection;
    }

    /**
     * Lazily instantiates the Mongoose model for a specific partition index.
     */
    private getPartitionModel(partitionId: number): Model<JobDocument> {
        if (this.models.has(partitionId)) {
            return this.models.get(partitionId)!;
        }

        const collectionName = `asynczap_jobs_${partitionId}`;
        
        let model: Model<JobDocument>;
        // Reuse existing model to prevent Mongoose OverwriteModelError
        if (this.connection.models[collectionName]) {
            model = this.connection.models[collectionName] as Model<JobDocument>;
        } else {
            model = this.connection.model<JobDocument>(collectionName, JobSchema, collectionName);
        }

        this.models.set(partitionId, model);
        return model;
    }

    /**
     * Explicitly forces index creation for a given partition collection.
     */
    async createPartitionCollection(partitionId: number): Promise<void> {
        const model = this.getPartitionModel(partitionId);
        await model.createCollection();
        await model.init(); // Builds indexes
    }

    /**
     * Inserts a single job directly into the correct partition.
     */
    async insertJob(partitionId: number, jobData: Partial<JobDocument>): Promise<JobDocument> {
        const model = this.getPartitionModel(partitionId);
        const doc = new model(jobData);
        const result = await doc.save();
        return result as JobDocument;
    }

    /**
     * Initializes a Change Stream on the partition collection.
     * @returns The ChangeStream object
     */
    watchPartition(partitionId: number, callback: () => void): any {
        const model = this.getPartitionModel(partitionId);
        const changeStream = model.watch([
            { $match: { operationType: 'insert' } }
        ]);

        changeStream.on('change', () => {
            callback();
        });

        return changeStream;
    }

    /**
     * Feature 9: Turbo Mode Prefetching
     * Atomically acquires a batch of jobs for high-throughput buffering.
     * Uses a multi-step optimistic locking pattern because MongoDB findOneAndUpdate
     * only supports single documents.
     */
    async fetchJobBatch(partitionId: number, workerId: string, batchSize: number): Promise<JobDocument[]> {
        const model = this.getPartitionModel(partitionId);
        const now = new Date();

        // 1. Find candidates optimistically
        const candidates = await model.find({
            status: 'pending',
            runAt: { $lte: now },
            remainingDependencies: 0
        })
        .sort({ priority: -1, runAt: 1 })
        .limit(batchSize)
        .select('_id')
        .lean()
        .exec();

        if (candidates.length === 0) return [];

        const candidateIds = candidates.map((c: any) => c._id);

        // 2. Atomically attempt to lock them
        await model.updateMany(
            {
                _id: { $in: candidateIds },
                status: 'pending' // crucial for atomic safety against other workers
            },
            {
                $set: {
                    status: 'processing',
                    lockedAt: now,
                    workerId: workerId
                }
            }
        );

        // 3. Fetch the ones we successfully locked
        const acquiredJobs = await model.find({
            _id: { $in: candidateIds },
            workerId: workerId,
            status: 'processing',
            lockedAt: now
        }).lean().exec();

        return acquiredJobs as JobDocument[];
    }

    /**
     * Executes an optimized bulk insertion into a specific partition.
     */
    async insertBulk(partitionId: number, jobsData: Partial<JobDocument>[]): Promise<JobDocument[]> {
        const model = this.getPartitionModel(partitionId);
        const result = await model.insertMany(jobsData);
        // Returning lean JS objects
        return result.map(doc => {
            const obj = doc.toObject ? doc.toObject() : doc;
            return obj as JobDocument;
        });
    }

    /**
     * Atomically acquires a single pending job and transitions it to 'processing'.
     * Sorts by highest priority first, then oldest runAt.
     */
    async acquireJob(partitionId: number, workerId: string): Promise<JobDocument | null> {
        const model = this.getPartitionModel(partitionId);
        const now = new Date();

        const job = await model.findOneAndUpdate(
            {
                status: 'pending',
                runAt: { $lte: now },
                remainingDependencies: 0 // <--- CRITICAL: Only pick jobs with no outstanding dependencies
            },
            {
                $set: {
                    status: 'processing',
                    lockedAt: now,
                    workerId: workerId
                }
            },
            {
                new: true, // return updated document
                sort: { priority: -1, runAt: 1 }
            }
        );

        return job ? (job.toObject() as JobDocument) : null;
    }

    /**
     * Updates fields on a targeted job (e.g. marking finished/failed).
     */
    async updateJobStatus(
        partitionId: number, 
        jobId: string, 
        updates: Partial<JobDocument>
    ): Promise<void> {
        const model = this.getPartitionModel(partitionId);
        await model.updateOne({ _id: jobId }, { $set: updates });
    }

    /**
     * Executes the DAG logic: When a job succeeds, find any job in this partition
     * that depends on this job, and decrement its dependency counter.
     * Note: In a distributed partitioned environment, dependencies might cross partitions.
     * This method assumes jobs might cross partitions, so it scans the given target partitions
     * or the caller must loop through all partitions.
     */
    async unlockDependentJobs(partitionId: number, completedJobId: string | Types.ObjectId): Promise<number> {
        const model = this.getPartitionModel(partitionId);
        const result = await model.updateMany(
            { 
                dependencies: completedJobId,
                remainingDependencies: { $gt: 0 } 
            },
            { 
                $inc: { remainingDependencies: -1 } 
            }
        );
        return result.modifiedCount;
    }

    /**
     * Instantiates the Dead Letter Queue model (asynczap_failed_jobs).
     */
    private getDLQModel(): Model<any> {
        const dlqCollection = 'asynczap_failed_jobs';
        if (this.connection.models[dlqCollection]) {
            return this.connection.models[dlqCollection];
        }
        const { DLQSchema } = require('../models/DLQModel');
        return this.connection.model(dlqCollection, DLQSchema, dlqCollection);
    }

    /**
     * Instantiates the History model (asynczap_job_history).
     */
    public getJobHistoryModel(): Model<any> {
        const historyCollection = 'asynczap_job_history';
        if (this.connection.models[historyCollection]) {
            return this.connection.models[historyCollection];
        }
        const { JobHistorySchema } = require('../models/JobHistoryModel');
        return this.connection.model(historyCollection, JobHistorySchema, historyCollection);
    }

    /**
     * Instantiates the Meta model (asynczap_meta) for dynamic partition scaling.
     */
    public getMetaModel(): Model<any> {
        const metaCollection = 'asynczap_meta';
        if (this.connection.models[metaCollection]) {
            return this.connection.models[metaCollection];
        }
        const { MetaSchema } = require('../models/MetaModel');
        return this.connection.model(metaCollection, MetaSchema, metaCollection);
    }

    /**
     * Instantiates the Worker Registry model (asynczap_workers) for node coordination.
     */
    public getWorkerModel(): Model<any> {
        const workerCollection = 'asynczap_workers';
        if (this.connection.models[workerCollection]) {
            return this.connection.models[workerCollection];
        }
        const { WorkerRegistrySchema } = require('../models/WorkerModel');
        return this.connection.model(workerCollection, WorkerRegistrySchema, workerCollection);
    }

    /**
     * Records a completed or permanently failed job into the history log.
     */
    async recordJobHistory(historyData: {
        originalJobId: string | Types.ObjectId;
        name: string;
        payload: any;
        result?: any;
        error?: string;
        workerId: string | null;
        status: 'completed' | 'failed';
        startedAt: Date;
    }): Promise<void> {
        const model = this.getJobHistoryModel();
        await model.create({
            ...historyData,
            finishedAt: new Date()
        });
    }

    /**
     * Instantiates the Tenant Stats model (asynczap_tenant_stats) for multi-tenant fairness.
     */
    public getTenantModel(): Model<any> {
        const tenantCollection = 'asynczap_tenant_stats';
        if (this.connection.models[tenantCollection]) {
            return this.connection.models[tenantCollection];
        }
        const { TenantStatSchema } = require('../models/TenantModel');
        return this.connection.model(tenantCollection, TenantStatSchema, tenantCollection);
    }

    /**
     * Instantiates the Idempotency model for deduping jobs.
     */
    public getIdempotencyModel(): Model<any> {
        const idempCollection = 'asynczap_idempotency';
        if (this.connection.models[idempCollection]) {
            return this.connection.models[idempCollection];
        }
        const { IdempotencySchema } = require('../models/IdempotencyModel');
        return this.connection.model(idempCollection, IdempotencySchema, idempCollection);
    }

    /**
     * Atomically ensures an idempotency key doesn't already exist.
     */
    async acquireIdempotencyLock(key: string): Promise<boolean> {
        const model = this.getIdempotencyModel();
        try {
            await model.create({ key, status: 'pending' });
            return true;
        } catch (err: any) {
            // Error code 11000 is Mongo's duplicate key constraint failure
            if (err.code === 11000) return false; 
            throw err;
        }
    }

    /**
     * Finalizes an idempotency lock efficiently with the job result.
     */
    async markIdempotencyCompleted(key: string, result: any): Promise<void> {
        const model = this.getIdempotencyModel();
        await model.updateOne({ key }, { $set: { status: 'completed', result } });
    }

    /**
     * Atomically moves a job from its partition to the Dead Letter Queue using a Transaction.
     * If transactions are not supported by the MongoDB deployment (e.g. standalone),
     * you can fallback to non-transactional inserts/deletes, but transactions are safer.
     */
    async moveToDLQ(partitionId: number, job: JobDocument, errorMsg: string): Promise<void> {
        const partitionModel = this.getPartitionModel(partitionId);
        const dlqModel = this.getDLQModel();
        
        const session = await this.connection.startSession();
        
        try {
            await session.withTransaction(async () => {
                // 1. Insert into DLQ
                await dlqModel.create([{
                    originalJobId: job._id,
                    partitionId: partitionId,
                    name: job.name,
                    payload: job.payload,
                    error: errorMsg,
                    attempts: job.attempts,
                    failedAt: new Date()
                }], { session });

                // 2. Delete from original partition queue
                await partitionModel.deleteOne({ _id: job._id }, { session });
            });
        } finally {
            await session.endSession();
        }
    }

    /**
     * Recovers jobs that have been locked for too long (e.g. worker crashed).
     * Resets status to pending and clears the lock.
     * @returns detailed array of jobs recovered for forensic logging
     */
    async recoverStaleJobs(partitionId: number, lockTimeoutMs: number): Promise<{ id: string, name: string, workerId: string, lockedAt: Date }[]> {
        const model = this.getPartitionModel(partitionId);
        const staleThreshold = new Date(Date.now() - lockTimeoutMs);

        const staleJobs = await model.find({
            status: 'processing',
            lockedAt: { $lt: staleThreshold }
        }).select('_id name workerId lockedAt').lean().exec();

        if (staleJobs.length === 0) return [];

        const jobIds = staleJobs.map(j => j._id);

        await model.updateMany(
            { _id: { $in: jobIds } },
            {
                $set: {
                    status: 'pending',
                    lockedAt: null,
                    workerId: null
                }
            }
        );

        return staleJobs.map((j: any) => ({
            id: j._id.toString(),
            name: j.name,
            workerId: j.workerId || 'unknown',
            lockedAt: j.lockedAt
        }));
    }
}
