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
    // PERF-02: TTL cache for available tenants
    private tenantCache: { data: string[], expiresAt: number } | null = null;

    constructor(adapter: MongoAdapter) {
        this.adapter = adapter;
    }

    /**
     * PERF-01: Collapsed to a single findOneAndUpdate with conditional increment.
     * Finds and increments active job count for a tenant if they are under their limit.
     * Returns true if allowed to proceed, false if throttled.
     */
    async trackJobStart(tenantId: string): Promise<boolean> {
        const tenantModel = this.adapter.getTenantModel();
        
        // Single atomic operation: upsert + conditional increment
        const result = await tenantModel.findOneAndUpdate(
            { tenantId, $expr: { $lt: ["$activeJobs", "$concurrencyLimit"] } },
            {
                $inc: { activeJobs: 1 },
                $setOnInsert: { tenantId, concurrencyLimit: 100, priorityTier: 0 }
            },
            { upsert: false, new: true }
        );

        if (result) return true;

        // If no match, ensure tenant doc exists (new tenant case)
        await tenantModel.updateOne(
            { tenantId },
            { $setOnInsert: { tenantId, activeJobs: 0, concurrencyLimit: 100, priorityTier: 0 } },
            { upsert: true }
        );

        return false;
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
        // Invalidate cache when tenant state changes
        this.tenantCache = null;
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
     * PERF-02: Cached with 500ms TTL to avoid DB query on every poll tick.
     * Fetches a list of tenants currently allowed to process jobs (sorted by priority tier).
     */
    async getAvailableTenants(): Promise<string[]> {
        // Return cached data if still fresh
        if (this.tenantCache && Date.now() < this.tenantCache.expiresAt) {
            return this.tenantCache.data;
        }

        const tenantModel = this.adapter.getTenantModel();
        
        const tenants = await tenantModel.find({
            $expr: { $lt: ["$activeJobs", "$concurrencyLimit"] }
        })
        .sort({ priorityTier: -1 })
        .limit(100)
        .select('tenantId')
        .lean();

        const data = tenants.map(t => t.tenantId);
        this.tenantCache = { data, expiresAt: Date.now() + 500 };
        return data;
    }
}
