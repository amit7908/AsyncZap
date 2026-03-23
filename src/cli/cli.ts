#!/usr/bin/env node
import { Command } from 'commander';
import mongoose, { Types } from 'mongoose';
import { AsyncZapQueue, Metrics } from '../index';

const program = new Command();

program
    .name('asynczap')
    .description('CLI management tools for AsyncZap')
    .version('1.0.0');

// Shared connection helper
async function connectToMongo(uri: string): Promise<AsyncZapQueue> {
    // SEC-01: Mask credentials in URI to prevent logging secrets
    console.log(`Connecting to MongoDB at ${uri.replace(/:([^@]+)@/, ':***@')}...`);
    await mongoose.connect(uri);
    // Hardcoded 4 for CLI defaults, though in production this might come from env/meta
    const queue = new AsyncZapQueue(mongoose.connection, { partitions: 4 });
    await queue.initialize();
    return queue;
}

program.command('stats')
    .description('View overall queue metrics and DLQ counts')
    .requiredOption('-u, --uri <string>', 'MongoDB connection URI')
    .action(async (options) => {
        try {
            const queue = await connectToMongo(options.uri);
            const metrics = new Metrics(queue);
            const stats = await metrics.getMetrics();
            
            console.log('\n====== AsyncZap Stats ======');
            console.log(`Partitions:          ${stats.partitions}`);
            console.log(`Pending:             ${stats.pending}`);
            console.log(`Processing:          ${stats.processing}`);
            console.log(`Completed:           ${stats.completed}`);
            console.log(`Failed (Retrying):   ${stats.failed}`);
            console.log(`Dead Letter Queue:   ${stats.deadLetterQueue}`);
            console.log(`Total Active:        ${stats.total}`);
            console.log('============================\n');
        } catch (error) {
            console.error('Error fetching stats:', error);
        } finally {
            await mongoose.disconnect();
        }
    });

program.command('start-worker')
    .description('Starts a barebones worker to process jobs from a specific partition')
    .requiredOption('-u, --uri <string>', 'MongoDB connection URI')
    .requiredOption('-p, --partitions <numbers>', 'Comma-separated partition IDs (e.g., "0,1,2")')
    .option('-c, --concurrency <number>', 'Concurrency level', '1')
    .action(async (options) => {
        try {
            const queue = await connectToMongo(options.uri);
            const partitions = options.partitions.split(',').map((p: string) => parseInt(p.trim(), 10));
            const concurrency = parseInt(options.concurrency, 10);

            const worker = queue.createWorker({ partitions, concurrency });
            
            // Dummy logger for CLI observability
            worker.on('job:processing', (job: any) => console.log(`[Processing] ${job._id} (${job.name}) on Partition ${partitions.join(',')}`));
            worker.on('job:completed', (job: any) => console.log(`✅ [Completed] ${job._id} (${job.name})`));
            worker.on('job:failed', (job: any, err: any) => console.log(`❌ [Failed] ${job._id} (${job.name}) - ${err.message}`));

            await worker.start();
            console.log(`\nWorker started! Polling partitions [${partitions.join(',')}] with concurrency ${concurrency}. Press Ctrl+C to exit.`);
            
            // Keep process alive
            process.on('SIGINT', async () => {
                console.log('\nShutting down worker gracefully...');
                await worker.stop();
                await mongoose.disconnect();
                process.exit(0);
            });
            
            // Block forever
            await new Promise(() => {});
        } catch (error) {
            console.error('Worker failed to start:', error);
            await mongoose.disconnect();
        }
    });

program
    .command('replay <id>')
    .description('Resurrect a failed job from history/DLQ')
    .requiredOption('-u, --uri <string>', 'MongoDB connection URI')
    .action(async (id, options) => {
        const uri = options.uri;
        await mongoose.connect(uri);
        
        // BUG-04 fix: Read real partition count from DB instead of hardcoding 1
        const meta = await mongoose.connection.collection('asynczap_meta').findOne({ _id: 'queue_config' as any });
        const partitions = (meta as any)?.partitions || 4;
        const queue = new AsyncZapQueue(mongoose.connection, { partitions });
        await queue.initialize();

        // SEC-04: Validate job ID format before DB query
        if (!Types.ObjectId.isValid(id)) {
            console.error('Invalid job ID format');
            process.exit(1);
        }

        console.log(`Replaying Job ID: ${id}`);
        try {
            await queue.replay.replayJob(id);
            console.log('✅ Job successfully queued for replay');
        } catch (err: any) {
            console.error('❌ Replay Failed:', err.message);
        }
        await mongoose.disconnect();
    });

program
    .command('workers')
    .description('List active worker nodes coordinating across the cluster')
    .requiredOption('-u, --uri <string>', 'MongoDB connection URI')
    .action(async (options) => {
        const uri = options.uri;
        await mongoose.connect(uri);
        const workersCount = await mongoose.connection.collection('asynczap_workers').countDocuments({ status: 'active' });
        const deadCount = await mongoose.connection.collection('asynczap_workers').countDocuments({ status: 'dead' });
        
        console.log(`--- Cluster Coordinator Node Status ---`);
        console.log(`Active Workers: ${workersCount}`);
        console.log(`Dead Workers:   ${deadCount}`);
        
        const activeList = await mongoose.connection.collection('asynczap_workers').find({ status: 'active' }).toArray();
        activeList.forEach((w: any) => {
            console.log(`- ID: ${w.workerId} | Host: ${w.host} | Partitions: [${w.partitions.join(',')}] | Heartbeat: ${w.heartbeatAt}`);
        });

        await mongoose.disconnect();
    });

program
    .command('dashboard')
    .description('Starts the AsyncZap Web Monitoring Dashboard')
    .requiredOption('-u, --uri <string>', 'MongoDB connection URI')
    .option('-p, --port <number>', 'Port to run the web server on', '3000')
    .option('-t, --token <string>', 'Optional bearer token for API authentication')
    .action(async (options) => {
        const uri = options.uri;
        console.log(`Starting AsyncZap Web Dashboard on port ${options.port}...`);
        
        // Dynamic import so we don't load fastify in standard CLI commands unless needed
        const { startDashboard } = require('../dashboard/server');
        await startDashboard(uri, parseInt(options.port), options.token);
    });

program.parse(process.argv);
