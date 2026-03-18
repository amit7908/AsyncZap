import { Schema, Document } from 'mongoose';

export interface WorkerRegistryDocument extends Document {
    workerId: string;
    host: string;
    partitions: number[];
    heartbeatAt: Date;
    status: 'active' | 'dead';
    createdAt: Date;
}

export const WorkerRegistrySchema = new Schema<WorkerRegistryDocument>({
    workerId: { type: String, required: true, unique: true },
    host: { type: String, required: true },
    partitions: [{ type: Number }],
    heartbeatAt: { type: Date, required: true, index: true },
    status: { type: String, enum: ['active', 'dead'], default: 'active' }
}, {
    timestamps: true,
    versionKey: false
});
