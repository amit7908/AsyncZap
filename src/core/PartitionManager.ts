import { EventEmitter } from 'events';
import { getPartitionIndex } from '../utils/partitionHash';
import { MongoAdapter } from '../adapters/MongoAdapter';

/**
 * Manages partition configuration and routing logic.
 * Dynamically reloads partition count from DB if the cluster scales.
 */
export class PartitionManager extends EventEmitter {
    private adapter?: MongoAdapter;
    private partitionCount: number;
    private version: number = 0;
    private syncTimer: NodeJS.Timeout | null = null;

    constructor(defaultPartitionCount: number = 1) {
        super();
        this.partitionCount = Math.max(1, defaultPartitionCount);
    }

    /**
     * Injects the adapter so the manager can poll the DB meta collection.
     */
    setAdapter(adapter: MongoAdapter) {
        this.adapter = adapter;
    }

    /**
     * Starts the background sync to detect cluster scaling.
     */
    startSync(intervalMs: number = 60000): void {
        this.syncTimer = setInterval(() => {
            this.syncWithDatabase().catch(err => console.error('[PartitionManager] Sync failed:', err.message));
        }, intervalMs);
        
        // Immediate first sync
        this.syncWithDatabase();
    }

    stopSync(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }

    private async syncWithDatabase(): Promise<void> {
        if (!this.adapter) return;

        const metaModel = this.adapter.getMetaModel();
        const config = await metaModel.findById('queue_config');
        
        if (config) {
            if (config.version > this.version) {
                console.log(`[PartitionManager] Scaling detected! Partitions updated: ${this.partitionCount} -> ${config.partitions}. (Version: ${config.version})`);
                this.partitionCount = config.partitions;
                this.version = config.version;
                this.emit('scaled', this.partitionCount);
            }
        } else {
            // First boot initialization — use upsert to prevent E11000 race across replicas
            const result = await metaModel.findOneAndUpdate(
                { _id: 'queue_config' },
                { $setOnInsert: { partitions: this.partitionCount, version: 1 } },
                { upsert: true, new: true }
            );
            this.partitionCount = result.partitions;
            this.version = result.version;
        }
    }

    /**
     * Returns the total number of partitions currently active in the cluster.
     */
    getPartitionCount(): number {
        return this.partitionCount;
    }

    /**
     * Given a job name or ID, returns the deterministic partition index it should route to.
     */
    getPartitionFor(key: string): number {
        return getPartitionIndex(key, this.partitionCount);
    }
}
