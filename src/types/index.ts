import { Types } from 'mongoose';
import { z } from 'zod';

export interface JobDocument<T = any> {
    _id: Types.ObjectId;
    name: string;
    tenantId: string;
    payload: T;
    idempotencyKey?: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    priority: number;
    attempts: number;
    maxAttempts: number;
    runAt: Date;
    lockedAt: Date | null;
    workerId: string | null;
    error?: string;
    result?: any;
    dependencies: Types.ObjectId[];
    remainingDependencies: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface JobOptions {
    priority?: number;
    maxAttempts?: number;
    delay?: number; // milliseconds to push runAt into the future
    tenantId?: string;
    idempotencyKey?: string;
    schema?: z.ZodSchema<any>;
}

export interface WorkerOptions {
    id?: string;
    partitions: number[];
    concurrency?: number;
    pollInterval?: number;
    lockTimeout?: number;
    heartbeatInterval?: number;
    maxActiveJobs?: number;       // Global backpressure limit across all workers
    prefetchBatchSize?: number;   // Turbo mode buffer prefetch size
}

export interface AsyncZapOptions {
    partitions: number; // Total number of partition collections to manage/expect
    plugins?: any[]; // Array of AsyncZapPlugins
}
