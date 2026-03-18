import { EventEmitter } from 'events';
import { MongoAdapter } from '../adapters/MongoAdapter';
import { PartitionManager } from './PartitionManager';

export interface CoordinatorOptions {
    pollIntervalMs?: number;    // How often to check for dead workers (default: 30000ms / 30 sec)
    deadTimeoutMs?: number;     // How long before a worker is considered completely dead (default: 120000ms / 2 min)
}

/**
 * WorkerCoordinator is a cluster-level background heartbeat monitor.
 * It sweeps the `asynczap_workers` collection to find dead nodes and explicitly cleans up their locks.
 */
export class WorkerCoordinator extends EventEmitter {
    private adapter: MongoAdapter;
    private partitionManager: PartitionManager;
    private options: Required<CoordinatorOptions>;
    private isRunning = false;
    private timerId: NodeJS.Timeout | null = null;

    constructor(adapter: MongoAdapter, partitionManager: PartitionManager, options: CoordinatorOptions = {}) {
        super();
        this.adapter = adapter;
        this.partitionManager = partitionManager;
        
        this.options = {
            pollIntervalMs: options.pollIntervalMs || 30000,
            deadTimeoutMs: options.deadTimeoutMs || 120000,
        };
    }

    /**
     * Starts the background monitor process.
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.emit('coordinator:started');
        
        this.timerId = setInterval(() => {
            this.reapDeadWorkers().catch(err => {
                this.emit('coordinator:error', err);
            });
        }, this.options.pollIntervalMs);

        // Feature 2: Trigger rebalance when partition topology changes
        this.partitionManager.on('scaled', () => {
            this.rebalancePartitions().catch(err => this.emit('coordinator:error', err));
        });
    }

    /**
     * Stops the monitor process.
     */
    stop(): void {
        this.isRunning = false;
        if (this.timerId) {
            clearInterval(this.timerId);
            this.timerId = null;
        }
        this.emit('coordinator:stopped');
    }

    /**
     * Scans for workers that haven't emitted a heartbeat recently.
     * Marks them as dead and relies on the QueueScheduler to unlock their specific jobs.
     */
    private async reapDeadWorkers(): Promise<void> {
        if (!this.isRunning) return;
        
        const workerModel = this.adapter.getWorkerModel();
        const deadThreshold = new Date(Date.now() - this.options.deadTimeoutMs);
        
        const result = await workerModel.updateMany(
            {
                status: 'active',
                heartbeatAt: { $lt: deadThreshold }
            },
            {
                $set: { status: 'dead' }
            }
        );

        if (result.modifiedCount > 0) {
            console.warn(`[WorkerCoordinator] Reaped ${result.modifiedCount} dead worker nodes.`);
            this.emit('coordinator:reaped', result.modifiedCount);
            
            // Rebalance partitions when cluster topology drops
            await this.rebalancePartitions();
        }
    }

    /**
     * Atomically redistributes partitions evenly across all active cluster nodes.
     * Can be invoked manually when new workers join or partition counts scale.
     */
    public async rebalancePartitions(): Promise<void> {
        const workerModel = this.adapter.getWorkerModel();
        
        // 1. Read all active workers
        const activeWorkers = await workerModel.find({ status: 'active' }).sort({ workerId: 1 }).exec();
        if (activeWorkers.length === 0) return;

        // 2. Read total desired partition count from cluster config
        const totalPartitions = this.partitionManager.getPartitionCount();
        
        // 3. Create buckets for each worker
        const assignments: number[][] = Array.from({ length: activeWorkers.length }, () => []);
        
        // Deal partitions in a round-robin fashion
        for (let i = 0; i < totalPartitions; i++) {
            const workerIndex = i % activeWorkers.length;
            assignments[workerIndex].push(i);
        }

        // 4. Atomically commit new topology individually for each worker.
        // Fast-path: Only update if the assignment actually changed.
        const promises = [];
        for (let i = 0; i < activeWorkers.length; i++) {
            const worker = activeWorkers[i];
            const assigned = assignments[i];
            
            // Basic array equality check
            const currentPartitions = worker.partitions || [];
            const changed = currentPartitions.length !== assigned.length || 
                            !currentPartitions.every((val: number, index: number) => val === assigned[index]);
            
            if (changed) {
                promises.push(
                    workerModel.updateOne(
                        { workerId: worker.workerId, status: 'active' }, // only if still active
                        { $set: { partitions: assigned } }
                    )
                );
            }
        }

        if (promises.length > 0) {
            await Promise.all(promises);
            this.emit('coordinator:rebalanced');
        }
    }
}
