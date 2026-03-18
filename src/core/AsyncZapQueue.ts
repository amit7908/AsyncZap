import { Connection } from 'mongoose';
import { MongoAdapter } from '../adapters/MongoAdapter';
import { PartitionManager } from './PartitionManager';
import { Worker } from './Worker';
import { JobDocument, JobOptions, AsyncZapOptions, WorkerOptions } from '../types';
import { JobReplay } from '../features/JobReplay';
import { PluginManager } from '../plugins/PluginManager';
import { TenantScheduler } from '../features/TenantScheduler';

/**
 * The main Queue orchestrator for the AsyncZap ecosystem.
 */
export class AsyncZapQueue {
    private adapter: MongoAdapter;
    private partitionManager: PartitionManager;
    public replay: JobReplay;
    public pluginManager: PluginManager;
    public tenantScheduler: TenantScheduler;

    constructor(connection: Connection, options: AsyncZapOptions) {
        this.adapter = new MongoAdapter(connection);
        this.partitionManager = new PartitionManager(options.partitions);
        this.partitionManager.setAdapter(this.adapter);
        this.pluginManager = new PluginManager();
        this.replay = new JobReplay(this);
        this.tenantScheduler = new TenantScheduler(this.adapter);

        if (options.plugins) {
            options.plugins.forEach(p => this.pluginManager.register(p));
        }
    }
    
    /**
     * Initializes the queue structure natively in MongoDB safely.
     * Iterates over all requested partitions ensuring collections and indexes exist.
     */
    async initialize(): Promise<void> {
        const counts = this.partitionManager.getPartitionCount();
        const promises = [];
        for (let i = 0; i < counts; i++) {
            promises.push(this.adapter.createPartitionCollection(i));
        }
        await Promise.all(promises);
        await this.pluginManager.emitQueueInit();
    }

    private validatePayload(payload: any, options: JobOptions): any {
        let validatedPayload = payload;
        if (options.schema) {
            const schemaResult = options.schema.safeParse(payload);
            if (!schemaResult.success) {
                throw new Error(`Payload validation failed: ${schemaResult.error.message}`);
            }
            validatedPayload = schemaResult.data;
        }

        if (typeof validatedPayload === 'object' && validatedPayload !== null) {
            const keys = Object.keys(validatedPayload);
            if (keys.some(k => k.startsWith('$'))) {
                throw new Error('Payload cannot contain root keys starting with $ (dangerous MongoDB operators)');
            }
        }

        try {
            const payloadStr = JSON.stringify(validatedPayload);
            if (Buffer.byteLength(payloadStr) > 1024 * 1024) { // 1MB limit
                throw new Error('Payload size exceeds the 1MB limit.');
            }
        } catch (err: any) {
            if (err.message === 'Payload size exceeds the 1MB limit.') throw err;
            throw new Error('Payload could not be serialized to JSON.');
        }

        return validatedPayload;
    }

    /**
     * Enqueues a single job. Routes the job into a specific partition hash bucket.
     * Silently drops the job and returns null if a duplicate idempotency key is provided.
     */
    async add<T = any>(name: string, payload: T, options: JobOptions = {}): Promise<JobDocument | null> {
        const validatedPayload = this.validatePayload(payload, options);

        if (options.idempotencyKey) {
            const locked = await this.adapter.acquireIdempotencyLock(options.idempotencyKey);
            if (!locked) {
                return null; // Duplicate request skipped
            }
        }

        // Evaluate hash to lock the target partition
        const partitionId = this.partitionManager.getPartitionFor(name);

        const jobDoc: Partial<JobDocument> = {
            name,
            tenantId: options.tenantId || 'default',
            payload: validatedPayload,
            status: 'pending',
            priority: options.priority || 0,
            maxAttempts: options.maxAttempts || 3,
            attempts: 0,
            runAt: options.delay ? new Date(Date.now() + options.delay) : new Date(),
            idempotencyKey: options.idempotencyKey,
        };

        return this.adapter.insertJob(partitionId, jobDoc);
    }

    /**
     * Enqueues multiple jobs efficiently. Group routes based on partition boundaries 
     * to leverage massive Mongoose Bulk-inserts via DB.
     */
    async addBulk(
        jobs: Array<{ name: string; payload: any; options?: JobOptions }>
    ): Promise<JobDocument[]> {
        // Bucket map: partition index -> Array<partial Job>
        const partitionBuckets = new Map<number, Partial<JobDocument>[]>();
        
        // Execute Idempotency filtering
        const validInputs = [];
        for (const input of jobs) {
            if (input.options && input.options.idempotencyKey) {
                const locked = await this.adapter.acquireIdempotencyLock(input.options.idempotencyKey);
                if (!locked) continue; // Skip duplicate
            }
            validInputs.push(input);
        }

        for (const input of validInputs) {
            const partitionId = this.partitionManager.getPartitionFor(input.name);
            const { name, options = {} } = input;
            const validatedPayload = this.validatePayload(input.payload, options);
            
            const jobDoc: Partial<JobDocument> = {
                name,
                payload: validatedPayload,
                status: 'pending',
                priority: options.priority || 0,
                maxAttempts: options.maxAttempts || 3,
                attempts: 0,
                runAt: options.delay ? new Date(Date.now() + options.delay) : new Date(),
                idempotencyKey: options.idempotencyKey,
            };
            
            if (!partitionBuckets.has(partitionId)) {
                partitionBuckets.set(partitionId, []);
            }
            partitionBuckets.get(partitionId)!.push(jobDoc);
        }
        
        // Execute Mongoose mapped inserts concurrently
        const results: JobDocument[] = [];
        const promises = Array.from(partitionBuckets.entries()).map(async ([pId, bucketJobs]) => {
            const inserted = await this.adapter.insertBulk(pId, bucketJobs);
            results.push(...inserted);
        });
        
        await Promise.all(promises);
        return results;
    }

    /**
     * Attaches a background worker natively linked to process this queue stack.
     */
    createWorker(options: WorkerOptions): Worker {
        return new Worker(this.adapter, options, this.pluginManager);
    }
}
