/**
 * JobQueue — Main Queue Class
 *
 * Database-agnostic job queue. All DB operations go through the adapter.
 * Handles: polling, processor registration, retry logic, events.
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { IQueueAdapter } from './interfaces/IQueueAdapter';
import {
    IJob,
    JobOptions,
    JobProcessor,
    QueueStats,
    QueueLogger,
    JobQueueConfig,
    BulkJobInput,
} from './interfaces/IJob';

/** Default console-based logger */
const defaultLogger: QueueLogger = {
    info: (msg: string, ...args: any[]) => console.log(`[JobQueue] ${msg}`, ...args),
    warn: (msg: string, ...args: any[]) => console.warn(`[JobQueue] ${msg}`, ...args),
    error: (msg: string, ...args: any[]) => console.error(`[JobQueue] ${msg}`, ...args),
};

export class JobQueue extends EventEmitter {
    private adapter: IQueueAdapter;
    private processors: Map<string, JobProcessor> = new Map();
    private isRunning = false;
    private pollInterval: number;
    private staleLockMinutes: number;
    private concurrency: number;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private logger: QueueLogger;
    private workerId: string;
    private activeJobs: Set<Promise<void>> = new Set();

    constructor(adapter: IQueueAdapter, config: JobQueueConfig = {}) {
        super();
        this.adapter = adapter;
        this.pollInterval = config.pollInterval || 5000;
        this.staleLockMinutes = config.staleLockMinutes || 5;
        this.concurrency = config.concurrency || 1;
        this.logger = config.logger || defaultLogger;
        this.workerId = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    }

    // ──────────────────────────────────────────────
    //  Processor Registration
    // ──────────────────────────────────────────────

    /**
     * Register a job processor for a specific job type
     *
     * @example
     * queue.define<{ to: string }>('send-email', async (data, job) => {
     *   await sendEmail(data.to);
     * });
     */
    define<T = any>(type: string, handler: JobProcessor<T>): void {
        this.processors.set(type, handler as JobProcessor);
        this.logger.info(`Processor registered: ${type}`);
    }

    // ──────────────────────────────────────────────
    //  Adding Jobs
    // ──────────────────────────────────────────────

    /**
     * Add a single job to the queue
     */
    async add<T = any>(type: string, data: T, options?: JobOptions): Promise<IJob<T>> {
        const job = await this.adapter.addJob<T>(type, data, options);
        this.logger.info(`Job added: ${type} (ID: ${job._id})`);
        this.emit('job:added', job);
        return job;
    }

    /**
     * Add multiple jobs at once
     */
    async addBulk<T = any>(jobs: BulkJobInput<T>[]): Promise<IJob<T>[]> {
        const result = await this.adapter.addBulkJobs<T>(jobs);
        this.logger.info(`Bulk jobs added: ${result.length}`);
        this.emit('jobs:added', result);
        return result;
    }

    // ──────────────────────────────────────────────
    //  Worker Lifecycle
    // ──────────────────────────────────────────────

    /**
     * Start the worker loop
     */
    async start(): Promise<void> {
        if (this.isRunning) return;

        this.isRunning = true;
        this.logger.info(`Worker started (ID: ${this.workerId}, concurrency: ${this.concurrency})`);
        this.emit('worker:started', this.workerId);

        // Reset stale jobs on startup
        const resetCount = await this.adapter.resetStaleJobs(this.staleLockMinutes);
        if (resetCount > 0) {
            this.logger.info(`Reset ${resetCount} stale jobs`);
        }

        // Main polling loop
        this.intervalId = setInterval(async () => {
            if (!this.isRunning) return;

            try {
                // Reset stale jobs each cycle
                await this.adapter.resetStaleJobs(this.staleLockMinutes);

                // Fill up to the concurrency limit
                while (this.isRunning && this.activeJobs.size < this.concurrency) {
                    const job = await this.adapter.fetchNextJob(this.workerId, this.staleLockMinutes);
                    if (!job) break; // No more pending jobs

                    this.logger.info(`Processing: ${job.type} (ID: ${job._id})`);
                    this.emit('job:processing', job);

                    // Launch concurrently — don't await here
                    const jobPromise = this.processJob(job)
                        .catch((err: any) => {
                            this.logger.error(`Job ${job._id} failed: ${err.message}`);
                        })
                        .finally(() => {
                            this.activeJobs.delete(jobPromise);
                        });

                    this.activeJobs.add(jobPromise);
                }
            } catch (error: any) {
                this.logger.error(`Worker error: ${error.message}`);
                this.emit('worker:error', error);
            }
        }, this.pollInterval);
    }

    /**
     * Stop the worker gracefully.
     * Stops polling and waits for all in-flight jobs to finish.
     */
    async stop(): Promise<void> {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;

        // Wait for all in-flight jobs to complete
        if (this.activeJobs.size > 0) {
            this.logger.info(`Waiting for ${this.activeJobs.size} in-flight job(s) to finish...`);
            await Promise.all(this.activeJobs);
        }

        this.logger.info('Worker stopped');
        this.emit('worker:stopped', this.workerId);
    }

    // ──────────────────────────────────────────────
    //  Job Processing (private)
    // ──────────────────────────────────────────────

    private async processJob(job: IJob): Promise<void> {
        const processor = this.processors.get(job.type);

        if (!processor) {
            this.logger.error(`No processor for job type: ${job.type}`);
            await this.adapter.markFailed(job._id, 'No processor registered for this job type');
            this.emit('job:failed', job, 'No processor registered');
            return;
        }

        // Start heartbeat to keep the lock alive for long-running jobs
        const heartbeatInterval = this.startHeartbeat(job);

        try {
            const result = await processor(job.data, job);
            await this.adapter.markCompleted(job._id, this.workerId, result);
            this.logger.info(`Completed: ${job.type} (ID: ${job._id})`);
            this.emit('job:completed', job, result);
        } catch (error: any) {
            await this.handleJobError(job, error);
        } finally {
            clearInterval(heartbeatInterval);
        }
    }

    /**
     * Periodically extend the lock on a running job to prevent
     * other workers from stealing it (Finding 4 fix).
     */
    private startHeartbeat(job: IJob): ReturnType<typeof setInterval> {
        // Heartbeat at half the stale lock interval
        const heartbeatMs = (this.staleLockMinutes * 60 * 1000) / 2;

        return setInterval(async () => {
            try {
                await this.adapter.extendLock(job._id, this.workerId);
            } catch (err: any) {
                this.logger.warn(`Heartbeat failed for job ${job._id}: ${err.message}`);
            }
        }, heartbeatMs);
    }

    private async handleJobError(job: IJob, error: Error): Promise<void> {
        const attempts = job.attempts + 1;
        const errorMessage = error.message || String(error);

        if (attempts < job.maxAttempts) {
            // Exponential backoff: 30s, 2min, 8min
            const delayMs = Math.pow(4, attempts) * 30 * 1000;
            const nextRunAt = new Date(Date.now() + delayMs);

            await this.adapter.retryJob(job._id, nextRunAt, errorMessage);
            this.logger.warn(`Retry scheduled: ${job.type} (attempt ${attempts}/${job.maxAttempts})`);
            this.emit('job:retry', job, attempts);
        } else {
            const finalError = `Max attempts reached. Last error: ${errorMessage}`;
            await this.adapter.markFailed(job._id, finalError);
            this.logger.error(`Failed permanently: ${job.type} (ID: ${job._id})`);
            this.emit('job:failed', job, finalError);
        }
    }

    // ──────────────────────────────────────────────
    //  Utilities
    // ──────────────────────────────────────────────

    /**
     * Get queue statistics
     */
    async getStats(): Promise<QueueStats> {
        return this.adapter.getStats();
    }

    /**
     * Clean old completed/failed jobs
     * @param daysOld - Delete jobs older than this many days (default: 7)
     */
    async cleanup(daysOld = 7): Promise<number> {
        const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
        const count = await this.adapter.cleanup(cutoff);
        this.logger.info(`Cleaned up ${count} old jobs`);
        return count;
    }

    /**
     * Get the worker ID for this instance
     */
    getWorkerId(): string {
        return this.workerId;
    }
}

