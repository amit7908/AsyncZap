import { Schema, Types } from 'mongoose';

export interface DLQDocument {
    _id?: Types.ObjectId;
    originalJobId: Types.ObjectId;
    partitionId: number;
    name: string;
    payload: any;
    error: string;
    failedAt: Date;
    attempts: number;
}

/**
 * Shared Mongoose schema for the Dead Letter Queue (DLQ).
 * All permanently failed jobs from all partitions are moved here.
 */
export const DLQSchema = new Schema<DLQDocument>({
    originalJobId: { type: Schema.Types.ObjectId, required: true },
    partitionId: { type: Number, required: true },
    name: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    error: { type: String, required: true },
    failedAt: { type: Date, default: Date.now },
    attempts: { type: Number, required: true }
}, {
    timestamps: false,
    versionKey: false
});

// Index for efficiently querying failed jobs by name or time
DLQSchema.index({ name: 1, failedAt: -1 });
DLQSchema.index({ originalJobId: 1 });
