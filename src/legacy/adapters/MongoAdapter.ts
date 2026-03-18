/**
 * MongoDB Adapter
 *
 * Implements IQueueAdapter using Mongoose.
 * Accepts an existing Mongoose connection — never creates its own.
 */

import { Connection, Schema, Model, Types } from 'mongoose';
import { IQueueAdapter } from '../interfaces/IQueueAdapter';
import { IJob, JobOptions, QueueStats, BulkJobInput } from '../interfaces/IJob';

/** Options for configuring the MongoAdapter */
export interface MongoAdapterOptions {
    /** MongoDB collection name (default: 'jobs') */
    collection?: string;
}

// ----- Mongoose Schema Definition (scoped, not global) -----

const JobSchema = new Schema(
    {
        type: { type: String, required: true, index: true },
        status: {
            type: String,
            default: 'pending',
            enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
            index: true,
        },
        data: { type: Schema.Types.Mixed, required: true },
        attempts: { type: Number, default: 0 },
        maxAttempts: { type: Number, default: 3 },
        priority: { type: Number, default: 0 },
        nextRunAt: { type: Date, default: Date.now, index: true },
        lockedAt: { type: Date, default: null },
        lockedBy: { type: String, default: null },
        processedBy: { type: String, default: null },
        result: { type: Schema.Types.Mixed, default: null },
        error: { type: String, default: null },
        completedAt: { type: Date, default: null },
        failedAt: { type: Date, default: null },
    },
    { timestamps: true, versionKey: false }
);

// Compound indexes for efficient job fetching
JobSchema.index({ status: 1, nextRunAt: 1, priority: -1 });
JobSchema.index({ status: 1, type: 1 });
JobSchema.index({ lockedAt: 1, status: 1 });

// ----- Adapter Implementation -----

export class MongoAdapter implements IQueueAdapter {
    private model: Model<any>;

    constructor(connection: Connection, options: MongoAdapterOptions = {}) {
        const collectionName = options.collection || 'jobs';

        // Register the model on the provided connection (not on global mongoose)
        // Check if model already exists on this connection to avoid OverwriteModelError
        if (connection.models[`JobQueue_${collectionName}`]) {
            this.model = connection.models[`JobQueue_${collectionName}`];
        } else {
            this.model = connection.model(
                `JobQueue_${collectionName}`,
                JobSchema,
                collectionName
            );
        }
    }

    async addJob<T = any>(type: string, data: T, options: JobOptions = {}): Promise<IJob<T>> {
        const doc = new this.model({
            type,
            data,
            priority: options.priority || 0,
            maxAttempts: options.maxAttempts || 3,
            nextRunAt: options.delay
                ? new Date(Date.now() + options.delay)
                : new Date(),
        });

        const saved = await doc.save();
        return saved.toObject() as IJob<T>;
    }

    async addBulkJobs<T = any>(jobs: BulkJobInput<T>[]): Promise<IJob<T>[]> {
        const docs = jobs.map(({ type, data, options = {} }) => ({
            type,
            data,
            priority: options.priority || 0,
            maxAttempts: options.maxAttempts || 3,
            nextRunAt: options.delay
                ? new Date(Date.now() + options.delay)
                : new Date(),
            status: 'pending',
        }));

        const result = await this.model.insertMany(docs);
        return result.map((doc: any) => doc.toObject()) as IJob<T>[];
    }

    async fetchNextJob(workerId: string, staleMinutes: number = 5): Promise<IJob | null> {
        const now = new Date();
        const staleLockTime = new Date(Date.now() - staleMinutes * 60 * 1000);

        const job = await this.model.findOneAndUpdate(
            {
                status: 'pending',
                nextRunAt: { $lte: now },
                $or: [
                    { lockedAt: null },
                    { lockedAt: { $lt: staleLockTime } },
                ],
            },
            {
                $set: {
                    status: 'processing',
                    lockedAt: now,
                    lockedBy: workerId,
                },
            },
            { new: true, sort: { priority: -1, nextRunAt: 1 } }
        );

        return job ? (job.toObject() as IJob) : null;
    }

    async markCompleted(jobId: string, workerId: string, result: any = null): Promise<void> {
        await this.model.findByIdAndUpdate(jobId, {
            $set: {
                status: 'completed',
                result,
                completedAt: new Date(),
                lockedAt: null,
                lockedBy: null,
                processedBy: workerId,
            },
        });
    }

    async markFailed(jobId: string, errorMessage: string): Promise<void> {
        await this.model.findByIdAndUpdate(jobId, {
            $set: {
                status: 'failed',
                error: errorMessage,
                failedAt: new Date(),
                lockedAt: null,
                lockedBy: null,
            },
        });
    }

    async retryJob(jobId: string, nextRunAt: Date, errorMessage: string): Promise<void> {
        await this.model.findByIdAndUpdate(jobId, {
            $set: {
                status: 'pending',
                nextRunAt,
                error: errorMessage,
                lockedAt: null,
                lockedBy: null,
            },
            $inc: { attempts: 1 },
        });
    }

    async resetStaleJobs(staleMinutes: number): Promise<number> {
        const staleTime = new Date(Date.now() - staleMinutes * 60 * 1000);

        const result = await this.model.updateMany(
            {
                status: 'processing',
                lockedAt: { $lt: staleTime },
            },
            {
                $set: { status: 'pending', lockedAt: null, lockedBy: null },
                $inc: { attempts: 1 },
            }
        );

        return result.modifiedCount;
    }

    async getStats(): Promise<QueueStats> {
        const [pending, processing, completed, failed] = await Promise.all([
            this.model.countDocuments({ status: 'pending' }),
            this.model.countDocuments({ status: 'processing' }),
            this.model.countDocuments({ status: 'completed' }),
            this.model.countDocuments({ status: 'failed' }),
        ]);

        return { pending, processing, completed, failed, total: pending + processing + completed + failed };
    }

    async cleanup(cutoffDate: Date): Promise<number> {
        const result = await this.model.deleteMany({
            status: { $in: ['completed', 'failed'] },
            updatedAt: { $lt: cutoffDate },
        });

        return result.deletedCount;
    }

    async extendLock(jobId: string, workerId: string): Promise<void> {
        await this.model.findOneAndUpdate(
            { _id: jobId, lockedBy: workerId, status: 'processing' },
            { $set: { lockedAt: new Date() } }
        );
    }

    async countPending(): Promise<number> {
        return this.model.countDocuments({ status: 'pending' });
    }
}
