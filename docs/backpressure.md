# Backpressure Management

When background workers process jobs too quickly, they might overwhelm downstream systems (APIs, Email providers, or Databases). **AsyncZap provides atomic, cluster-wide backpressure configuration.**

## What is Backpressure?
Backpressure acts as a safety valve. If you specify a maximum of `10` active jobs, and you deploy 50 isolated workers across 5 servers, AsyncZap natively guarantees that no more than `10` jobs will actively run at any exact millisecond.

## How It Works

Traditional models rely on Redis for atomic counts. AsyncZap uses MongoDB's built-in atomicity:
1. `asynczap_counters` collection contains a global counter.
2. A worker attempts to acquire a slot using `findOneAndUpdate({ slots: { $lt: Math.abs(maxActiveJobs) } }, { $inc: { slots: 1 } })`.
3. If it succeeds, the job continues.
4. If it fails, the worker pauses and relinquishes the job back to the partition.

## Configuring Global Limits

Simply provide the `maxActiveJobs` limit to your worker configuration.

```typescript
const worker = queue.createWorker({
  partitions: [0, 1, 2],
  concurrency: 5,        // Max 5 concurrent jobs on THIS machine
  maxActiveJobs: 2       // Max 2 jobs ACROSS THE WHOLE CLUSTER
});
```

With the above configuration, even if you run 10 instances of `worker`, the cluster-wide processing throughput is firmly guarded at a ceiling of 2 instances.
