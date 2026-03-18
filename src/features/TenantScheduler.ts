import { MongoAdapter } from '../adapters/MongoAdapter';
import { JobDocument } from '../types';

/**
 * TenantScheduler is responsible for "Fair Scheduling" across multiple tenants.
 * It prevents a single noisy tenant from starving the worker pool by:
 * 1. Tracking active running jobs per tenant
 * 2. Enforcing tenant concurrency limits
 * 3. Utilizing Priority Tiers
 */
export class TenantScheduler {
    private adapter: MongoAdapter;

    constructor(adapter: MongoAdapter) {
        this.adapter = adapter;
    }

    /**
     * Finds and increments active job count for a tenant if they are under their limit.
     * Returns true if allowed to proceed, false if throttled.
     */
    async trackJobStart(tenantId: string): Promise<boolean> {
        const tenantModel = this.adapter.getTenantModel();
        
        // Ensure tenant exists
        await tenantModel.updateOne(
            { tenantId },
            { $setOnInsert: { tenantId, activeJobs: 0, concurrencyLimit: 100, priorityTier: 0 } },
            { upsert: true }
        );

        // Attempt to increment only if below concurrency limit
        const result = await tenantModel.updateOne(
            { tenantId, $expr: { $lt: ["$activeJobs", "$concurrencyLimit"] } },
            { $inc: { activeJobs: 1 } }
        );

        return result.modifiedCount > 0;
    }

    /**
     * Decrements the active job count for a tenant when a job finishes.
     */
    async trackJobEnd(tenantId: string): Promise<void> {
        const tenantModel = this.adapter.getTenantModel();
        await tenantModel.updateOne(
            { tenantId, activeJobs: { $gt: 0 } },
            { $inc: { activeJobs: -1 } }
        );
    }

    /**
     * Sets or updates the concurrency limit for a specific tenant.
     */
    async setTenantLimit(tenantId: string, limit: number): Promise<void> {
        const tenantModel = this.adapter.getTenantModel();
        await tenantModel.updateOne(
            { tenantId },
            { $set: { concurrencyLimit: limit }, $setOnInsert: { activeJobs: 0, priorityTier: 0 } },
            { upsert: true }
        );
    }

    /**
     * Fetches a list of tenants currently allowed to process jobs (sorted by priority tier).
     */
    async getAvailableTenants(): Promise<string[]> {
        const tenantModel = this.adapter.getTenantModel();
        
        // We find tenants where activeJobs < concurrencyLimit, sort descending by priority
        const tenants = await tenantModel.find({
            $expr: { $lt: ["$activeJobs", "$concurrencyLimit"] }
        })
        .sort({ priorityTier: -1 })
        .limit(100) // Sanity limit for huge multi-tenant systems
        .select('tenantId')
        .lean();

        return tenants.map(t => t.tenantId);
    }
}
