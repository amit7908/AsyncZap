# Architecture & Design

AsyncZap achieves horizontal scalability and high throughput using MongoDB by rethinking how jobs are stored and retrieved. 

## The Concurrency Problem in MongoDB

Traditional MongoDB job queues (like Agenda) store all jobs in a single collection. When multiple workers try to `findOneAndUpdate` (lock) the next pending job, they encounter **lock contention**:
1. Worker A queries for a job.
2. Worker B queries simultaneously.
3. Both attempt to lock the same document.
4. One fails and must retry, wasting database cycles and increasing latency.

## The AsyncZap Solution: Partitioning

AsyncZap solves this using **Horizontal Partitioning**.

Instead of one `jobs` collection, you configure an N-partition queue. AsyncZap creates `asynczap_jobs_0`, `asynczap_jobs_1`, up to `N`.

### Deterministic Routing
When you add a job, AsyncZap hashes the job's name (or ID) and routes it to a specific partition:
`Job "send-email" -> asynczap_jobs_2`

### Independent Polling
Workers are assigned specific partitions. Worker 1 might poll partitions 0 and 1, while Worker 2 polls 2 and 3.
Because workers poll *distinct collections*, **cross-worker contention drops to zero**.

## Core Components
* **AsyncZapQueue**: The orchestrator, handling ingestion and partitioning.
* **PartitionManager**: Manages the cluster topology dynamically.
* **Worker**: Independent processing nodes bound to specific collections.
* **Metrics / Prometheus**: Aggregates partition telemetry for Grafana.

## Dynamic Scaling
AsyncZap allows scaling the partition count dynamically. Cluster admins update the `queue_config` meta document, and workers automatically detect the change via background sync intervals and start routing gracefully.
