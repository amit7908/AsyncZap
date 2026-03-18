/**
 * mongo-jobqueue
 *
 * A lightweight, database-agnostic job queue for Node.js
 * Currently supports MongoDB via Mongoose
 */

// Core
export { JobQueue } from './JobQueue';

// Adapters
export { MongoAdapter, MongoAdapterOptions } from './adapters/MongoAdapter';

// Interfaces
export {
    IJob,
    JobStatus,
    JobOptions,
    QueueStats,
    BulkJobInput,
    JobProcessor,
    JobQueueConfig,
    QueueLogger,
} from './interfaces/IJob';

export { IQueueAdapter } from './interfaces/IQueueAdapter';

// NestJS (optional — available if @nestjs/common is installed)
export {
    MongoQueueModule,
    MongoQueueModuleOptions,
    MongoQueueModuleAsyncOptions,
    JOB_QUEUE_TOKEN,
} from './nestjs/MongoQueueModule';
