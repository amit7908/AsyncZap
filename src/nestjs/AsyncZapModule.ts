import { DynamicModule, Module, Provider, Global } from '@nestjs/common';
import { Connection } from 'mongoose';
import { AsyncZapOptions } from '../types';
import { AsyncZapService, ASYNCZAP_CONNECTION, ASYNCZAP_OPTIONS } from './AsyncZapService';

export interface AsyncZapModuleAsyncOptions {
    imports?: any[];
    inject?: any[];
    useFactory: (...args: any[]) => Promise<{ connection: Connection; options: AsyncZapOptions }> | { connection: Connection; options: AsyncZapOptions };
}

@Global()
@Module({})
export class AsyncZapModule {
    /**
     * Asynchronously registers the queue module.
     * Ideal for injecting the Mongoose Connection from `@nestjs/mongoose`.
     */
    static forRootAsync(options: AsyncZapModuleAsyncOptions): DynamicModule {
        const asyncProvider: Provider = {
            provide: ASYNCZAP_OPTIONS_FACTORY,
            useFactory: options.useFactory,
            inject: options.inject || [],
        };

        const connectionProvider: Provider = {
            provide: ASYNCZAP_CONNECTION,
            useFactory: (factoryObj: { connection: Connection }) => factoryObj.connection,
            inject: [ASYNCZAP_OPTIONS_FACTORY],
        };

        const configProvider: Provider = {
            provide: ASYNCZAP_OPTIONS,
            useFactory: (factoryObj: { options: AsyncZapOptions }) => factoryObj.options,
            inject: [ASYNCZAP_OPTIONS_FACTORY],
        };

        return {
            module: AsyncZapModule,
            imports: options.imports || [],
            providers: [
                asyncProvider,
                connectionProvider,
                configProvider,
                AsyncZapService
            ],
            exports: [AsyncZapService],
        };
    }
}

const ASYNCZAP_OPTIONS_FACTORY = 'ASYNCZAP_OPTIONS_FACTORY';
