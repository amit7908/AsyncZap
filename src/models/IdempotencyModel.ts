import { Schema, Document } from 'mongoose';

export interface IdempotencyDocument extends Document {
    key: string;
    status: 'pending' | 'completed';
    result?: any;
    createdAt: Date;
    updatedAt: Date;
}

export const IdempotencySchema = new Schema<IdempotencyDocument>({
    key: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    result: { type: Schema.Types.Mixed }
}, {
    timestamps: true,
    versionKey: false
});

// Automatically expire idempotency keys after 30 days to free up DB space and prevent infinite growth
IdempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
