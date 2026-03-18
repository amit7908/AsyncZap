import http from 'http';
import mongoose from 'mongoose';
import { Metrics } from '../features/Metrics';
import { AsyncZapQueue } from '../core/AsyncZapQueue';

/**
 * Bootstraps a lightweight embedded web dashboard server.
 * Instead of forcing massive Fastify/Express/React dependencies on users installing AsyncZap,
 * we expose an embedded zero-dependency dashboard via HTTP module and simple HTML/JS.
 */
export async function startDashboard(mongoUri: string, port: number = 3000): Promise<void> {
    await mongoose.connect(mongoUri);
    const queue = new AsyncZapQueue(mongoose.connection, { partitions: 1 }); // Just for adapter access
    const adapter = (queue as any).adapter;
    const metaModel = adapter.getMetaModel();
        
    let partitionCount = 1;
    try {
        const config = await metaModel.findById('queue_config');
        if (config) partitionCount = config.partitions;
    } catch(e) {}

    const metricsReader = new Metrics(queue);

    const server = http.createServer(async (req, res) => {
        // Simple HTML SPA delivery
        if (req.url === '/' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(getHtmlTemplate());
            return;
        }

        // Prometheus external scrape endpoint
        if (req.url === '/metrics' && req.method === 'GET') {
            try {
                const metrics = await metricsReader.getMetrics();
                const activeWorkers = await mongoose.connection.collection('asynczap_workers').countDocuments({ status: 'active' });
                
                res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
                res.end(metricsReader.toPrometheus(metrics, activeWorkers));
            } catch (err: any) {
                res.writeHead(500);
                res.end(err.message);
            }
            return;
        }

        // JSON REST API endpoint (legacy fetch)
        if (req.url === '/api/metrics' && req.method === 'GET') {
            try {
                const metrics = await metricsReader.getMetrics();
                const activeWorkers = await mongoose.connection.collection('asynczap_workers').countDocuments({ status: 'active' });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    totals: {
                        pending: metrics.pending,
                        processing: metrics.processing,
                        dlq: metrics.deadLetterQueue
                    },
                    partitionCount,
                    activeWorkers
                }));
            } catch (err: any) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        // Feature 6: Server-Sent Events (SSE) Live Telemetry Stream
        if (req.url === '/api/events' && req.method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });

            const sendMetrics = async () => {
                try {
                    const metrics = await metricsReader.getMetrics();
                    const activeWorkers = await mongoose.connection.collection('asynczap_workers').countDocuments({ status: 'active' });
                    const payload = JSON.stringify({
                        totals: {
                            pending: metrics.pending,
                            processing: metrics.processing,
                            dlq: metrics.deadLetterQueue
                        },
                        partitionCount,
                        activeWorkers
                    });
                    res.write(`data: ${payload}\n\n`);
                } catch(e) {}
            };

            // Send immediate first payload
            sendMetrics();

            // Setup interval for push telemetry
            const interval = setInterval(sendMetrics, 2000);

            // Cleanup on close
            req.on('close', () => clearInterval(interval));
            return;
        }

        res.writeHead(404);
        res.end('Not Found');
    });

    server.listen(port, () => {
        console.log(`🚀 AsyncZap Dashboard live at http://localhost:${port}`);
    });
}

function getHtmlTemplate(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AsyncZap Dashboard</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #0d1117; color: #c9d1d9; margin: 0; padding: 2rem; }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { color: #58a6ff; font-weight: 600; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 2rem; }
        .card { background-color: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 1.5rem; text-align: center; }
        .card h3 { margin-top: 0; color: #8b949e; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; }
        .card .value { font-size: 2.5rem; font-weight: 700; }
        .value.pending { color: #f2cc60; }
        .value.processing { color: #58a6ff; }
        .value.dlq { color: #f85149; }
        .value.workers { color: #3fb950; }
        .refreshing { font-size: 0.8rem; color: #8b949e; text-align: right; margin-top: 1rem; }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ AsyncZap Console</h1>
        <p>Live cluster telemetry. Auto-refreshing every 3 seconds.</p>

        <div class="grid" id="metrics-grid">
            <div class="card"><h3>Pending Jobs</h3><div class="value pending" id="val-pending">0</div></div>
            <div class="card"><h3>Processing</h3><div class="value processing" id="val-processing">0</div></div>
            <div class="card"><h3>Dead Letter Queue</h3><div class="value dlq" id="val-dlq">0</div></div>
            <div class="card"><h3>Active Workers</h3><div class="value workers" id="val-workers">0</div></div>
        </div>
        
        <div class="refreshing">Last update: <span id="last-update">-</span></div>
    </div>

    <script>
        const source = new EventSource('/api/events');
        
        source.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                document.getElementById('val-pending').innerText = data.totals.pending;
                document.getElementById('val-processing').innerText = data.totals.processing;
                document.getElementById('val-dlq').innerText = data.totals.dlq;
                document.getElementById('val-workers').innerText = data.activeWorkers;
                document.getElementById('last-update').innerText = new Date().toLocaleTimeString();
            } catch (err) {}
        };

        source.onerror = function(err) {
            console.error("SSE Streaming connection lost, reconnecting...");
        };
    </script>
</body>
</html>
    `;
}
