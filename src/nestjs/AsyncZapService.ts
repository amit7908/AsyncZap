import { Injectable, Inject, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Connection } from 'mongoose';
import { AsyncZapQueue } from '../core/AsyncZapQueue';
import { Worker } from '../core/Worker';
import { WorkflowEngine } from '../features/WorkflowEngine';
import { Metrics } from '../features/Metrics';
import { AsyncZapOptions, WorkerOptions, JobOptions } from '../types';

export const ASYNCZAP_CONNECTION = 'ASYNCZAP_CONNECTION';
export const ASYNCZAP_OPTIONS = 'ASYNCZAP_OPTIONS';

@Injectable()
export class AsyncZapService implements OnApplicationBootstrap, OnApplicationShutdown {
    public queue: AsyncZapQueue;
    public workflow: WorkflowEngine;
    public metrics: Metrics;
    private workers: Worker[] = [];

    constructor(
        @Inject(ASYNCZAP_CONNECTION) private readonly connection: Connection,
        @Inject(ASYNCZAP_OPTIONS) private readonly options: AsyncZapOptions
    ) {
        this.queue = new AsyncZapQueue(this.connection, this.options);
        this.workflow = new WorkflowEngine(this.queue);
        this.metrics = new Metrics(this.queue);
    }

    /**
     * Called automatically by NestJS.
     * Ensures all partition collections and indexes are initialized before accepting traffic.
     */
    async onApplicationBootstrap() {
        await this.queue.initialize();
    }

    /**
     * Called automatically by NestJS on shutdown (SIGTERM).
     * Stops all linked workers gracefully to prevent orphaned database locks.
     */
    async onApplicationShutdown() {
        const stops = this.workers.map(w => w.stop());
        await Promise.all(stops);
    }

    // --- Developer Exopsed API ---

    async add<T = any>(name: string, payload: T, options?: JobOptions) {
        return this.queue.add(name, payload, options);
    }

    async addBulk(jobs: Array<{ name: string; payload: any; options?: JobOptions }>) {
        return this.queue.addBulk(jobs);
    }

    createWorker(options: WorkerOptions): Worker {
        const worker = this.queue.createWorker(options);
        this.workers.push(worker);
        return worker;
    }
}
