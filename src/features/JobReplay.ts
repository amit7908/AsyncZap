import { Types } from 'mongoose';
import { AsyncZapQueue } from '../core/AsyncZapQueue';

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
     * @param originalJobId The original ObjectId of the job.
     * @param newPayload Optional new payload to replace the original payload.
     */
    async replayJob(originalJobId: string | Types.ObjectId, newPayload?: any): Promise<any> {
        const adapter = (this.queue as any).adapter;
        const historyModel = adapter.getJobHistoryModel();
        
        // 1. Locate the job in the History Log
        const historicalJob = await historyModel.findOne({ originalJobId }).sort({ finishedAt: -1 });

        if (!historicalJob) {
            throw new Error(`JobReplay Error: Could not find job history for ID ${originalJobId}`);
        }

        // 2. Enqueue as a fresh job (resetting attempts and dependencies)
        // If it was part of a DAG, replaying just this job breaks the original graph,
        // so it runs standalone by default.
        const job = await this.queue.add(historicalJob.name, newPayload !== undefined ? newPayload : historicalJob.payload, {
            priority: 0,
            maxAttempts: 3 // Reset back to default or could pull from config
        });

        return job;
    }

    /**
     * Mass replays all failed jobs currently trapped in the Dead Letter Queue.
     * Warning: This can cause a sudden massive spike in queue traffic.
     */
    async replayAllFailedJobs(): Promise<number> {
        const adapter = (this.queue as any).adapter;
        const dlqModel = adapter.getDLQModel();
        
        const failedJobsCursor = dlqModel.find({}).cursor();
        let resurrectedCount = 0;

        // Traverse using a cursor to prevent memory limit crashes for huge DLQs
        for await (const dlqDoc of failedJobsCursor) {
            await this.queue.add(dlqDoc.name, dlqDoc.payload, {
                priority: 0,
                maxAttempts: 3
            });
            // Delete from DLQ
            await dlqModel.deleteOne({ _id: dlqDoc._id });
            resurrectedCount++;
        }

        return resurrectedCount;
    }
}
