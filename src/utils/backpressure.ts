import { MongoAdapter } from '../adapters/MongoAdapter';

/**
 * Handles Global Backpressure Control using an atomic counter
 * in the 'asynczap_counters' collection.
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

        // Robust atomic increment with condition
        const result = await collection.findOneAndUpdate(
            { _id: counterId, value: { $lt: this.maxActiveJobs } },
            { $inc: { value: 1 } },
            { upsert: false }
        );

        // Handle different driver versions for findOneAndUpdate result
        // V5/V6 driver returns the document directly. V4 returns { value: doc, ok: 1 }
        let doc = null;
        if (result) {
            doc = (result._id !== undefined) ? result : result.value;
        }
        
        if (doc && typeof doc.value === 'number') {
            return true;
        }

        // Initialize if document missing or current check failed
        await collection.updateOne(
            { _id: counterId },
            { $setOnInsert: { value: 0 } },
            { upsert: true }
        );

        // Ensure 'value' field exists even if it was upserted differently
        await collection.updateOne(
            { _id: counterId, value: { $exists: false } },
            { $set: { value: 0 } }
        );

        // Final try
        const retryResult = await collection.findOneAndUpdate(
            { _id: counterId, value: { $lt: this.maxActiveJobs } },
            { $inc: { value: 1 } },
            { upsert: false }
        );

        let retryDoc = null;
        if (retryResult) {
            retryDoc = (retryResult._id !== undefined) ? retryResult : retryResult.value;
        }
        
        return !!(retryDoc && typeof retryDoc.value === 'number');
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
