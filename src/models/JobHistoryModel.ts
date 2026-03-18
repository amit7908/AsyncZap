import { Schema, Types } from 'mongoose';

export interface JobHistoryDocument {
    _id?: Types.ObjectId;
    originalJobId: string | Types.ObjectId;
    name: string;
    payload: any;
    result?: any;
    error?: string;
    workerId: string | null;
    status: 'completed' | 'failed';
    startedAt: Date;
    finishedAt: Date;
}

export const JobHistorySchema = new Schema<JobHistoryDocument>({
    originalJobId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    result: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    workerId: { type: String, default: null },
    status: { type: String, required: true, enum: ['completed', 'failed'] },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: Date.now, expires: '30d' }
}, {
    timestamps: false,
    versionKey: false
});

JobHistorySchema.index({ originalJobId: 1 });
JobHistorySchema.index({ name: 1, finishedAt: -1 });
JobHistorySchema.index({ status: 1 });
