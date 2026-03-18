/**
 * Job interfaces and types
 */

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

/**
 * Options when adding a new job
 */
export interface JobOptions {
    /** Higher number = higher priority (default: 0) */
    priority?: number;
    /** Maximum retry attempts (default: 3) */
    maxAttempts?: number;
    /** Delay in milliseconds before the job becomes available */
    delay?: number;
}

/**
 * A job document as stored in the database
 */
export interface IJob<T = any> {
    _id: string;
    type: string;
    status: JobStatus;
    data: T;
    attempts: number;
    maxAttempts: number;
    priority: number;
    nextRunAt: Date;
    lockedAt: Date | null;
    lockedBy: string | null;
    processedBy: string | null;
    result: any;
    error: string | null;
    completedAt: Date | null;
    failedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Queue statistics
 */
export interface QueueStats {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    total: number;
}

/**
 * Bulk job input
 */
export interface BulkJobInput<T = any> {
    type: string;
    data: T;
    options?: JobOptions;
}

/**
 * Job processor function signature
 */
export type JobProcessor<T = any> = (data: T, job: IJob<T>) => Promise<any>;

/**
 * Configuration for the JobQueue
 */
export interface JobQueueConfig {
    /** Polling interval in milliseconds (default: 5000) */
    pollInterval?: number;
    /** Stale lock timeout in minutes (default: 5) */
    staleLockMinutes?: number;
    /** Maximum number of jobs to process concurrently (default: 1) */
    concurrency?: number;
    /** Custom logger (default: console) */
    logger?: QueueLogger;
}

/**
 * Logger interface — users can plug in any logger (winston, pino, console, etc.)
 */
export interface QueueLogger {
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
}
