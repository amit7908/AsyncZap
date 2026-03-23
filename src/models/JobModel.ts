import { Schema } from 'mongoose';
import { JobDocument } from '../types';

/**
 * Shared Mongoose schema for all AsyncZap partitions.
 * Instead of registering this globally on 'mongoose.model',
 * it is instantiated dynamically per partition by the MongoAdapter.
 */
export const JobSchema = new Schema<JobDocument>({
    name: { type: String, required: true },
    tenantId: { type: String, required: true, default: 'default' },
    idempotencyKey: { type: String, required: false },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
        type: String,
        default: 'pending',
        enum: ['pending', 'processing', 'completed', 'failed'],
    },
    priority: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    runAt: { type: Date, default: Date.now },
    lockedAt: { type: Date, default: null },
    workerId: { type: String, default: null },
    error: { type: String, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    lockToken: { type: String, default: null },
    dependencies: [{ type: Schema.Types.ObjectId }],
    remainingDependencies: { type: Number, default: 0 }
}, {
    timestamps: true, // Auto-manages createdAt and updatedAt
    versionKey: false,
    minimize: false // Preserve empty objects like payload: {} through Mongoose round-trips
});

// Minimal Index Strategy for High Write Throughput

// 1. Atomic Locking Hot-Path
// Required for efficient polling sorted by priority and runAt
JobSchema.index({ status: 1, priority: -1, runAt: 1 });

// 2. Lock recovery
JobSchema.index({ lockedAt: 1 });

// 3. Workflow DAG Unlocking
// Used when a job completes to rapidly decrement remainingDependencies on child jobs
JobSchema.index({ dependencies: 1, remainingDependencies: 1 });
