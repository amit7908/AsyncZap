/**
 * NestJS Dynamic Module for JobQueue
 *
 * Usage:
 *   MongoQueueModule.forRoot(mongooseConnection, { collection: 'jobs' })
 *   MongoQueueModule.forRootAsync({ useFactory: ..., inject: ... })
 *
 * NOTE: This module has an optional dependency on @nestjs/common.
 * If @nestjs/common is not installed, this file simply won't be usable,
 * but the rest of the package works fine for Express/vanilla Node.js.
 */

import { JobQueue } from '../JobQueue';
import { MongoAdapter, MongoAdapterOptions } from '../adapters/MongoAdapter';
import { JobQueueConfig } from '../interfaces/IJob';
import { Connection } from 'mongoose';

// We use dynamic imports via type references so @nestjs/common is NOT a hard dependency.
// Users who don't use NestJS won't need it installed.
let NestCommon: any;
try {
    NestCommon = require('@nestjs/common');
} catch {
    // @nestjs/common not available — that's fine for non-NestJS users
}

/** Token for injecting the JobQueue in NestJS */
export const JOB_QUEUE_TOKEN = 'JOB_QUEUE';

/** Options for forRoot */
export interface MongoQueueModuleOptions {
    connection: Connection;
    adapterOptions?: MongoAdapterOptions;
    queueConfig?: JobQueueConfig;
}

/** Options for forRootAsync */
export interface MongoQueueModuleAsyncOptions {
    imports?: any[];
    useFactory: (...args: any[]) => MongoQueueModuleOptions | Promise<MongoQueueModuleOptions>;
    inject?: any[];
}

/**
 * Create the NestJS Module class dynamically.
 * This avoids importing @nestjs/common at the top level.
 */
function createMongoQueueModule() {
    if (!NestCommon) {
        throw new Error(
            'MongoQueueModule requires @nestjs/common to be installed. ' +
            'Install it with: npm install @nestjs/common'
        );
    }

    const { Module, Global } = NestCommon;

    @Global()
    @Module({})
    class MongoQueueModule {
        /**
         * Synchronous registration
         *
         * @example
         * MongoQueueModule.forRoot(mongoose.connection, { collection: 'jobs' })
         */
        static forRoot(
            connection: Connection,
            adapterOptions?: MongoAdapterOptions,
            queueConfig?: JobQueueConfig
        ) {
            const adapter = new MongoAdapter(connection, adapterOptions);
            const queue = new JobQueue(adapter, queueConfig);

            return {
                module: MongoQueueModule,
                providers: [
                    { provide: JOB_QUEUE_TOKEN, useValue: queue },
                    { provide: JobQueue, useValue: queue },
                ],
                exports: [JOB_QUEUE_TOKEN, JobQueue],
            };
        }

        /**
         * Async registration (for injecting dependencies)
         *
         * @example
         * MongoQueueModule.forRootAsync({
         *   imports: [MongooseModule],
         *   useFactory: (connection: Connection) => ({
         *     connection,
         *     adapterOptions: { collection: 'jobs' },
         *   }),
         *   inject: [getConnectionToken()],
         * })
         */
        static forRootAsync(options: MongoQueueModuleAsyncOptions) {
            return {
                module: MongoQueueModule,
                imports: options.imports || [],
                providers: [
                    {
                        provide: JOB_QUEUE_TOKEN,
                        useFactory: async (...args: any[]) => {
                            const config = await options.useFactory(...args);
                            const adapter = new MongoAdapter(config.connection, config.adapterOptions);
                            return new JobQueue(adapter, config.queueConfig);
                        },
                        inject: options.inject || [],
                    },
                    {
                        provide: JobQueue,
                        useExisting: JOB_QUEUE_TOKEN,
                    },
                ],
                exports: [JOB_QUEUE_TOKEN, JobQueue],
            };
        }
    }

    return MongoQueueModule;
}

// Lazy-export: only evaluates when the consumer actually accesses a property
// (e.g. MongoQueueModule.forRoot(...)). This prevents a crash when
// @nestjs/common is not installed but the user only imports non-NestJS parts.
let _cachedModule: any = null;

export const MongoQueueModule: any = new Proxy(
    {},
    {
        get(_target, prop, receiver) {
            if (!_cachedModule) {
                _cachedModule = createMongoQueueModule();
            }
            return Reflect.get(_cachedModule, prop, receiver);
        },
    }
);
