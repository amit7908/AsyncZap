import crypto from 'crypto';
import { EventEmitter } from 'events';
import { MongoAdapter } from '../adapters/MongoAdapter';
import { WorkerOptions, JobDocument } from '../types';
import { calculatePollDelay } from '../utils/pollingStrategy';
import { calculateExponentialBackoff } from '../features/RetryStrategy';
import { TenantScheduler } from '../features/TenantScheduler';
import { PluginManager } from '../plugins/PluginManager';
import { BackpressureManager } from '../utils/backpressure';

export type JobHandler<T = any> = (job: JobDocument<T>) => Promise<any>;

export class Worker extends EventEmitter {
    public readonly workerId: string;
    private adapter: MongoAdapter;
    private options: Required<WorkerOptions>;
    private handlers: Map<string, JobHandler> = new Map();
    private isRunning = false;
    private activeJobsCount = 0;

    // For round-robin adaptive polling across assigned partitions
    private currentPartitionIndex = 0;
    private tenantScheduler: TenantScheduler;
    private pluginManager?: PluginManager;
    private backpressureManager?: BackpressureManager;
    private jobBuffer: JobDocument[] = [];
    private sleepEmitter = new EventEmitter();
    private activeChangeStreams: any[] = [];

    constructor(adapter: MongoAdapter, options: WorkerOptions, pluginManager?: PluginManager) {
        super();
        this.adapter = adapter;
        this.tenantScheduler = new TenantScheduler(adapter);
        this.pluginManager = pluginManager;
        this.workerId = `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

        this.options = {
            id: options.id || crypto.randomUUID(),
            partitions: options.partitions,
            concurrency: options.concurrency || 1,
            pollInterval: options.pollInterval || 1000,
            lockTimeout: options.lockTimeout || 300000,
            heartbeatInterval: options.heartbeatInterval || 15000,
            maxActiveJobs: options.maxActiveJobs || 0,
            prefetchBatchSize: options.prefetchBatchSize || 0
        };

        if (this.options.partitions.length === 0) {
            throw new Error('Worker must be assigned at least one partition');
        }

        if (this.options.maxActiveJobs && this.options.maxActiveJobs > 0) {
            this.backpressureManager = new BackpressureManager(this.adapter, this.options.maxActiveJobs);
        }

        // Feature 6: Concurrency Safety
        this.sleepEmitter.setMaxListeners(Math.max(100, this.options.concurrency * 2));
    }

    process<T = any>(name: string, handler: JobHandler<T>): void {
        this.handlers.set(name, handler as JobHandler);
    }

    private heartbeatTimer: NodeJS.Timeout | null = null;

    private async registerWorker(): Promise<void> {
        const workerModel = this.adapter.getWorkerModel();
        await workerModel.updateOne(
            { workerId: this.workerId },
            {
                $set: {
                    host: require('os').hostname(),
                    partitions: this.options.partitions,
                    heartbeatAt: new Date(),
                    status: 'active'
                }
            },
            { upsert: true }
        );
    }

    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            this.registerWorker().catch(err => console.error(`[Worker ${this.workerId}] Heartbeat failed:`, err.message));
        }, this.options.heartbeatInterval);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        const workerModel = this.adapter.getWorkerModel();
        workerModel.updateOne({ workerId: this.workerId }, { $set: { status: 'dead' } }).catch(() => { });
    }

    async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        this.emit('worker:started', this.workerId);

        await this.registerWorker();
        this.startHeartbeat();

        try {
            for (const pId of this.options.partitions) {
                const stream = this.adapter.watchPartition(pId, () => {
                    this.triggerWakeup();
                });
                stream.on('error', () => {
                    try { stream.close(); } catch (e) { }
                });
                this.activeChangeStreams.push(stream);
            }
        } catch (err) { }

        this.pollLoop();
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        this.triggerWakeup();
        for (const stream of this.activeChangeStreams) {
            try { await stream.close(); } catch (e) { }
        }
        while (this.activeJobsCount > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.stopHeartbeat();
        this.emit('worker:stopped', this.workerId);
    }

    private async pollLoop(): Promise<void> {
        while (this.isRunning) {
            if (this.activeJobsCount >= this.options.concurrency) {
                await this.delay(100);
                continue;
            }

            const targetPartition = this.options.partitions[this.currentPartitionIndex];
            let globalSlotAcquired = false;
            let slotHandedOff = false;

            try {
                if (this.backpressureManager) {
                    globalSlotAcquired = await this.backpressureManager.acquireSlot(targetPartition);
                    if (!globalSlotAcquired) {
                        this.currentPartitionIndex = (this.currentPartitionIndex + 1) % this.options.partitions.length;
                        if (this.currentPartitionIndex === 0) {
                            await this.delay(calculatePollDelay(this.options.pollInterval));
                        }
                        continue;
                    }
                }

                await this.tenantScheduler.getAvailableTenants();

                let job: JobDocument | null = null;
                const batchSize = this.options.prefetchBatchSize;

                if (batchSize && batchSize > 1) {
                    if (this.jobBuffer.length < Math.ceil(batchSize / 2)) {
                        const newJobs = await this.adapter.fetchJobBatch(
                            targetPartition,
                            this.options.id,
                            batchSize - this.jobBuffer.length
                        );
                        if (newJobs.length > 0) this.jobBuffer.push(...newJobs);
                    }
                    if (this.jobBuffer.length > 0) job = this.jobBuffer.shift() || null;
                } else {
                    job = await this.adapter.acquireJob(targetPartition, this.options.id);
                }

                if (job) {
                    const tenantId = job.tenantId || 'default';
                    const allowed = await this.tenantScheduler.trackJobStart(tenantId);

                    if (!allowed) {
                        await this.adapter.updateJobStatus(targetPartition, job._id.toString(), {
                            status: 'pending', lockedAt: null, workerId: null
                        });
                        await this.delay(500);
                        continue;
                    }

                    slotHandedOff = true;
                    this.executeJob(job, targetPartition, tenantId, globalSlotAcquired).catch(err => {
                        console.error('Execute Job Background Error:', err);
                    });
                    continue;
                }
            } catch (err) {
                this.emit('worker:error', err);
            } finally {
                if (globalSlotAcquired && !slotHandedOff) {
                    await this.backpressureManager?.releaseSlot(targetPartition);
                }
            }

            this.currentPartitionIndex = (this.currentPartitionIndex + 1) % this.options.partitions.length;
            if (this.currentPartitionIndex === 0) {
                await this.delay(calculatePollDelay(this.options.pollInterval));
            }
        }
    }

    private async executeJob(job: JobDocument, partitionId: number, tenantId: string, globalSlotAcquired: boolean): Promise<void> {
        this.activeJobsCount++;
        this.emit('job:started', job);
        this.emit('job:processing', job);

        if (this.pluginManager) {
            await this.pluginManager.emitJobStart(job);
        }

        const handler = this.handlers.get(job.name);

        if (!handler) {
            await this.adapter.updateJobStatus(partitionId, job._id.toString(), {
                status: 'failed',
                error: `No handler registered for job: ${job.name}`
            });
            this.activeJobsCount--;
            this.emit('job:failed', job, new Error('No handler'));
            return;
        }

        try {
            const result = await handler(job);
            await this.adapter.updateJobStatus(partitionId, job._id.toString(), {
                status: 'completed',
                result: result,
            });
            if (job.idempotencyKey) {
                await this.adapter.markIdempotencyCompleted(job.idempotencyKey, result);
            }
            this.emit('job:completed', job, result);
            for (const pId of this.options.partitions) {
                const unlocked = await this.adapter.unlockDependentJobs(pId, job._id);
                if (unlocked > 0) {
                    this.emit('workflow:unlocked', job._id, unlocked);
                }
            }
            await this.adapter.recordJobHistory({
                originalJobId: job._id,
                name: job.name,
                payload: job.payload || {},
                result: result,
                workerId: this.workerId,
                status: 'completed',
                startedAt: job.lockedAt || new Date()
            });
            if (this.pluginManager) {
                await this.pluginManager.emitJobSuccess(job, result);
            }
        } catch (error: any) {
            const errorMessage = error.message || String(error);
            const attempts = job.attempts + 1;
            if (attempts >= job.maxAttempts) {
                await this.adapter.moveToDLQ(partitionId, { ...job, attempts }, errorMessage);
                this.emit('job:failed', job, new Error(`Max attempts reached: ${errorMessage}`));
                await this.adapter.recordJobHistory({
                    originalJobId: job._id,
                    name: job.name,
                    payload: job.payload || {},
                    error: errorMessage,
                    workerId: this.workerId,
                    status: 'failed',
                    startedAt: job.lockedAt || new Date()
                });
                if (this.pluginManager) {
                    await this.pluginManager.emitJobFail(job, new Error(errorMessage));
                }
            } else {
                const nextRunAt = calculateExponentialBackoff(attempts);
                await this.adapter.updateJobStatus(partitionId, job._id.toString(), {
                    status: 'pending',
                    lockedAt: null,
                    workerId: null,
                    attempts: attempts,
                    error: errorMessage,
                    runAt: nextRunAt
                });
                this.emit('job:retrying', job, attempts, nextRunAt);
            }
        } finally {
            await this.tenantScheduler.trackJobEnd(tenantId);
            if (globalSlotAcquired) await this.backpressureManager?.releaseSlot(partitionId);
            this.activeJobsCount--;
        }
    }

    private delay(ms: number) {
        return new Promise(resolve => {
            const timeout = setTimeout(resolve, ms);
            this.sleepEmitter.once('wakeup', () => {
                clearTimeout(timeout);
                resolve(null);
            });
        });
    }

    private triggerWakeup() {
        this.sleepEmitter.emit('wakeup');
    }
}
