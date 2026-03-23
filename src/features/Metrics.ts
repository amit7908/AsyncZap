import { Model } from 'mongoose';
import { AsyncZapQueue } from '../core/AsyncZapQueue';
import { JobDocument } from '../types';

export interface QueueMetrics {
    partitions: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    deadLetterQueue: number;
    total: number;
}

/**
 * Gathers cluster-wide metrics across all partition collections.
 */
export class Metrics {
    private queue: AsyncZapQueue;

    constructor(queue: AsyncZapQueue) {
        this.queue = queue;
    }

    /**
     * Aggregates job counts across all underlying MongoDB partition collections.
     */
    async getMetrics(): Promise<QueueMetrics> {
        const partitionManager = this.queue.getPartitionManager();
        const adapter = this.queue.getAdapter();
        const count = partitionManager.getPartitionCount();

        const metrics: QueueMetrics = {
            partitions: count,
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
            deadLetterQueue: 0,
            total: 0
        };

        const promises = [];

        // 1. Gather metrics from every live partition
        for (let i = 0; i < count; i++) {
            const model: Model<JobDocument> = adapter.getPartitionModel(i);
            
            promises.push(
                model.aggregate([
                    { $group: { _id: '$status', count: { $sum: 1 } } }
                ]).then(results => {
                    for (const { _id, count } of results) {
                        if (_id === 'pending') metrics.pending += count;
                        if (_id === 'processing') metrics.processing += count;
                        if (_id === 'completed') metrics.completed += count;
                        if (_id === 'failed') metrics.failed += count;
                        metrics.total += count;
                    }
                })
            );
        }

        // 2. Gather metrics from the Dead Letter Queue
        const dlqModel: Model<any> = adapter.getDLQModel();
        promises.push(
            dlqModel.countDocuments().then(c => {
                metrics.deadLetterQueue = c;
            })
        );

        await Promise.all(promises);

        return metrics;
    }

    /**
     * Formats the collected metrics into standard Prometheus text-based format.
     */
    toPrometheus(metrics: QueueMetrics, activeWorkers: number): string {
        return `
# HELP asynczap_pending_jobs Number of jobs waiting to be processed
# TYPE asynczap_pending_jobs gauge
asynczap_pending_jobs ${metrics.pending}

# HELP asynczap_processing_jobs Number of jobs currently being processed
# TYPE asynczap_processing_jobs gauge
asynczap_processing_jobs ${metrics.processing}

# HELP asynczap_completed_jobs Number of successfully completed jobs
# TYPE asynczap_completed_jobs counter
asynczap_completed_jobs ${metrics.completed}

# HELP asynczap_failed_jobs Number of permanently failed jobs in DLQ
# TYPE asynczap_failed_jobs counter
asynczap_failed_jobs ${metrics.deadLetterQueue}

# HELP asynczap_worker_count Number of active worker nodes
# TYPE asynczap_worker_count gauge
asynczap_worker_count ${activeWorkers}

# HELP asynczap_partition_count Number of active queue partitions
# TYPE asynczap_partition_count gauge
asynczap_partition_count ${metrics.partitions}
`.trim() + '\n';
    }
}
