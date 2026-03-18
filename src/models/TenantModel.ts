import { Schema, Document } from 'mongoose';

export interface TenantStatDocument extends Document {
    tenantId: string;
    activeJobs: number;
    concurrencyLimit: number;
    priorityTier: number; // For prioritizing VIP tenants during overall acquisition
    updatedAt: Date;
}

export const TenantStatSchema = new Schema<TenantStatDocument>({
    tenantId: { type: String, required: true, unique: true },
    activeJobs: { type: Number, default: 0 },
    concurrencyLimit: { type: Number, default: 100 },
    priorityTier: { type: Number, default: 0 }
}, {
    timestamps: true,
    versionKey: false
});
