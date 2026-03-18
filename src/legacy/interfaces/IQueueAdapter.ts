/**
 * Queue Adapter Interface
 *
 * Any database adapter must implement this contract.
 * This enables swapping MongoDB for PostgreSQL, MySQL, etc. in the future.
 */

import { IJob, JobOptions, QueueStats, BulkJobInput } from './IJob';

export interface IQueueAdapter {
    /**
     * Add a single job to the queue
     */
    addJob<T = any>(type: string, data: T, options?: JobOptions): Promise<IJob<T>>;

    /**
     * Add multiple jobs at once
     */
    addBulkJobs<T = any>(jobs: BulkJobInput<T>[]): Promise<IJob<T>[]>;

    /**
     * Atomically fetch and lock the next pending job
     * Must prevent race conditions (two workers grabbing the same job)
     * @param staleMinutes - Override the stale lock timeout (default: 5)
     */
    fetchNextJob(workerId: string, staleMinutes?: number): Promise<IJob | null>;

    /**
     * Mark a job as completed
     */
    markCompleted(jobId: string, workerId: string, result?: any): Promise<void>;

    /**
     * Mark a job as failed (permanently)
     */
    markFailed(jobId: string, errorMessage: string): Promise<void>;

    /**
     * Retry a job — put it back to pending with a delay
     */
    retryJob(jobId: string, nextRunAt: Date, errorMessage: string): Promise<void>;

    /**
     * Reset jobs that have been stuck in 'processing' state
     */
    resetStaleJobs(staleMinutes: number): Promise<number>;

    /**
     * Extend the lock on a running job (heartbeat).
     * Prevents other workers from stealing a long-running job.
     */
    extendLock(jobId: string, workerId: string): Promise<void>;

    /**
     * Get queue statistics
     */
    getStats(): Promise<QueueStats>;

    /**
     * Delete old completed/failed jobs
     */
    cleanup(cutoffDate: Date): Promise<number>;

    /**
     * Count pending jobs
     */
    countPending(): Promise<number>;
}
