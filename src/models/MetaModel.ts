import { Schema, Document } from 'mongoose';

export interface MetaDocument {
    _id: string;          // Hardcoded to 'queue_config' for singleton
    partitions: number;   // The current active number of partition collections
    version: number;      // Auto-incremented when scaling occurs to notify workers
    updatedAt: Date;
}

export const MetaSchema = new Schema<MetaDocument>({
    _id: { type: String, default: 'queue_config' },
    partitions: { type: Number, required: true },
    version: { type: Number, default: 1 }
}, {
    timestamps: true,
    versionKey: false
});
