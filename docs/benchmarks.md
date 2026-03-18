# Performance Benchmarks

AsyncZap is built for high throughput. We test against constrained network endpoints (like MongoDB Atlas Free Tier) to demonstrate worst-case networking bottlenecks.

## Bulk vs Sequential Enqueue

When inserting hundreds or thousands of jobs, `addBulk()` should always be preferred.

### Atlas M0 Free Tier (Network Bound: ~180ms RTT)
* **Single Enqueue**: ~5 jobs/second
* **Bulk Enqueue**: **871 jobs/second** (~174x faster)

### Local / VPC MongoDB (Low Latency)
When your queue runs in the same VPC as your database, latency is virtually eliminated.
* **Single Enqueue**: ~100+ jobs/second
* **Bulk Enqueue**: **~8,000+ jobs/second**

## Turbo Mode (Prefetching)

Workers usually use `findOneAndUpdate` sequentially. To improve processing speed, configure the worker with `prefetchBatchSize`:

```typescript
const worker = queue.createWorker({
  partitions: [0, 1],
  prefetchBatchSize: 10
});
```

Instead of 10 DB round-trips to lock 10 jobs, AsyncZap will issue a bulk update to lock 10 jobs into a local buffer, immediately distributing them to async handlers.

## Latency Percentiles

AsyncZap focuses on stable latencies. With "Anti-Thundering Herd" random polling jitter, database connection spikes are smoothed out.
