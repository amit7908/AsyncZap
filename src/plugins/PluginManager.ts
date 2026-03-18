import { JobDocument } from '../types';

/**
 * Interface that all external AsyncZap plugins must implement.
 * Plugins allow intercepting the lifecycle of the queue and jobs.
 */
export interface AsyncZapPlugin {
    name: string;
    onQueueInit?(): Promise<void> | void;
    onJobStart?(job: JobDocument): Promise<void> | void;
    onJobSuccess?(job: JobDocument, result: any): Promise<void> | void;
    onJobFail?(job: JobDocument, error: Error): Promise<void> | void;
}

/**
 * Manages the registration and execution of external plugins.
 */
export class PluginManager {
    private plugins: AsyncZapPlugin[] = [];

    register(plugin: AsyncZapPlugin): void {
        this.plugins.push(plugin);
    }

    async emitQueueInit(): Promise<void> {
        for (const p of this.plugins) {
            if (p.onQueueInit) {
                try { await p.onQueueInit(); } catch (err) { console.error(`[Plugin ${p.name}] Error onQueueInit:`, err); }
            }
        }
    }

    async emitJobStart(job: JobDocument): Promise<void> {
        for (const p of this.plugins) {
            if (p.onJobStart) {
                try { await p.onJobStart(job); } catch (err) { console.error(`[Plugin ${p.name}] Error onJobStart:`, err); }
            }
        }
    }

    async emitJobSuccess(job: JobDocument, result: any): Promise<void> {
        for (const p of this.plugins) {
            if (p.onJobSuccess) {
                try { await p.onJobSuccess(job, result); } catch (err) { console.error(`[Plugin ${p.name}] Error onJobSuccess:`, err); }
            }
        }
    }

    async emitJobFail(job: JobDocument, error: Error): Promise<void> {
        for (const p of this.plugins) {
            if (p.onJobFail) {
                try { await p.onJobFail(job, error); } catch (err) { console.error(`[Plugin ${p.name}] Error onJobFail:`, err); }
            }
        }
    }
}
