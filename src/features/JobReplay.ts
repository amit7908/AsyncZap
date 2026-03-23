import { Types } from 'mongoose';
import { AsyncZapQueue } from '../core/AsyncZapQueue';

export interface ReplayOptions {
    batchSize?: number;
    delayBetweenBatchesMs?: number;
}

/**
 * Handles resurrecting jobs from the Job History audit log or the Dead Letter Queue.
 */
export class JobReplay {
    private queue: AsyncZapQueue;

    constructor(queue: AsyncZapQueue) {
        this.queue = queue;
    }

    /**
     * Finds a historical/failed job by its original ID, and adds it back to the queue pipeline.
     */
    async replayJob(originalJobId: string | Types.ObjectId, newPayload?: any): Promise<any> {
        const adapter = this.queue.getAdapter(); // QA-01
        const historyModel = adapter.getJobHistoryModel();
        
        const historicalJob = await historyModel.findOne({ originalJobId }).sort({ finishedAt: -1 });

        if (!historicalJob) {
            throw new Error(`JobReplay Error: Could not find job history for ID ${originalJobId}`);
        }

        const job = await this.queue.add(historicalJob.name, newPayload !== undefined ? newPayload : historicalJob.payload, {
            priority: 0,
            maxAttempts: 3
        });

        return job;
    }

    /**
     * QA-07: Mass replays with rate-limiting to prevent queue saturation.
     * Processes in batches with configurable delay between each batch.
     */
    async replayAllFailedJobs(options: ReplayOptions = {}): Promise<{ replayed: number; total: number }> {
        const { batchSize = 100, delayBetweenBatchesMs = 1000 } = options;
        const adapter = this.queue.getAdapter(); // QA-01
        const dlqModel = adapter.getDLQModel();
        
        const total = await dlqModel.countDocuments();
        const failedJobsCursor = dlqModel.find({}).cursor();
        let replayed = 0;
        let batchCount = 0;

        for await (const dlqDoc of failedJobsCursor) {
            await this.queue.add(dlqDoc.name, dlqDoc.payload, {
                priority: 0,
                maxAttempts: 3
            });
            await dlqModel.deleteOne({ _id: dlqDoc._id });
            replayed++;
            batchCount++;

            // Rate-limit: pause between batches
            if (batchCount >= batchSize) {
                batchCount = 0;
                await new Promise(resolve => setTimeout(resolve, delayBetweenBatchesMs));
            }
        }

        return { replayed, total };
    }
}
