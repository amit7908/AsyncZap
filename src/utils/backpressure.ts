import { MongoAdapter } from '../adapters/MongoAdapter';

/**
 * Handles Global Backpressure Control using an atomic counter
 * in the 'asynczap_counters' collection.
 * PERF-05: Counter documents are pre-seeded during initialize(), so acquireSlot
 * uses a single findOneAndUpdate without fallback chain.
 */
export class BackpressureManager {
    private adapter: MongoAdapter;
    private maxActiveJobs: number;

    constructor(adapter: MongoAdapter, maxActiveJobs: number) {
        this.adapter = adapter;
        this.maxActiveJobs = maxActiveJobs;
    }

    /**
     * Attempts to atomically acquire a processing slot for a specific partition.
     * Only succeeds if current active_jobs for this partition < maxActiveJobs.
     * @returns True if a slot was acquired, false if the partition is saturated.
     */
    async acquireSlot(partitionId: number): Promise<boolean> {
        if (this.maxActiveJobs <= 0) return true; // Disabled

        const counterId = `active_jobs_partition_${partitionId}`;
        const collection = (this.adapter as any).connection.collection('asynczap_counters');

        // PERF-05: Single atomic operation — counters are pre-seeded during initialize()
        const result = await collection.findOneAndUpdate(
            { _id: counterId, value: { $lt: this.maxActiveJobs } },
            { $inc: { value: 1 } },
            { returnDocument: 'after' }
        );

        return result !== null;
    }

    /**
     * Atomically releases a processing slot for a specific partition.
     */
    async releaseSlot(partitionId: number): Promise<void> {
        if (this.maxActiveJobs <= 0) return; // Disabled

        const counterId = `active_jobs_partition_${partitionId}`;
        const collection = (this.adapter as any).connection.collection('asynczap_counters');
        await collection.updateOne(
            { _id: counterId },
            { $inc: { value: -1 } }
        );
    }
}
