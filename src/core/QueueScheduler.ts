import { EventEmitter } from 'events';
import { MongoAdapter } from '../adapters/MongoAdapter';
import { PartitionManager } from './PartitionManager';

export interface SchedulerOptions {
    pollIntervalMs?: number;    // How often to check for stalled jobs (default: 60000ms / 1 min)
    lockTimeoutMs?: number;     // How long a lock can be held before deemed stalled (default: 300000ms / 5 min)
}

/**
 * QueueScheduler is a standalone maintenance process.
 * It is responsible for identifying jobs that have been locked for too long
 * (indicating a worker crashed) and returning them to the pending pool.
 */
export class QueueScheduler extends EventEmitter {
    private adapter: MongoAdapter;
    private partitionManager: PartitionManager;
    private options: Required<SchedulerOptions>;
    private isRunning = false;
    private timerId: NodeJS.Timeout | null = null;

    constructor(adapter: MongoAdapter, partitionManager: PartitionManager, options: SchedulerOptions = {}) {
        super();
        this.adapter = adapter;
        this.partitionManager = partitionManager;
        
        this.options = {
            pollIntervalMs: options.pollIntervalMs || 60000,
            lockTimeoutMs: options.lockTimeoutMs || 300000,
        };
    }

    /**
     * Starts the background scheduler process.
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.emit('scheduler:started');
        
        this.timerId = setInterval(() => {
            this.recoverStaleJobs().catch(err => {
                this.emit('scheduler:error', err);
            });
        }, this.options.pollIntervalMs);
        
        // Run immediately on start
        this.recoverStaleJobs();
    }

    /**
     * Stops the background scheduler process.
     */
    stop(): void {
        this.isRunning = false;
        if (this.timerId) {
            clearInterval(this.timerId);
            this.timerId = null;
        }
        this.emit('scheduler:stopped');
    }

    /**
     * Iterates across ALL partitions to find and unlock stale jobs.
     */
    private async recoverStaleJobs(): Promise<void> {
        if (!this.isRunning) return;
        
        let totalRecovered = 0;
        const counts = this.partitionManager.getPartitionCount();
        
        for (let i = 0; i < counts; i++) {
            const recoveredJobs = await this.adapter.recoverStaleJobs(i, this.options.lockTimeoutMs);
            if (recoveredJobs && recoveredJobs.length > 0) {
                totalRecovered += recoveredJobs.length;
                for (const job of recoveredJobs) {
                    console.warn(`[Crash Recovery | Partition ${i}] Unlocked stalled job '${job.name}' (ID: ${job.id}) from dead worker '${job.workerId}'`);
                }
            }
        }

        if (totalRecovered > 0) {
            this.emit('scheduler:recovered', totalRecovered);
        }
    }
}
