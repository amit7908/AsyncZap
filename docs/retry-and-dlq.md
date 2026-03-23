# Retries and Dead Letter Queue (DLQ)

Jobs fail. APIs go down, tokens expire, networks flap.
AsyncZap embraces this reality through a combination of exponential backoff, retry constraints, and a configurable Dead Letter Queue (DLQ).

## Handling Job Failures

### Automatic Retries

When a job throws an error, AsyncZap automatically retries the job. 
```typescript
await queue.add('charge-card', { amount: 100 }, { maxAttempts: 5 });
```

The time between retries increases exponentially to allow downstream services to recover:
* Attempt 1 -> Fail
* Delay 1s -> Attempt 2
* Delay 4s -> Attempt 3
* Delay 9s -> Attempt 4
* Delay 16s -> Attempt 5

### The Dead Letter Queue (DLQ)

When a job exhausts all of its retry attempts (e.g., fails 5 times), it is permanently removed from the active `jobs` partition and inserted into the `asynczap_dlq` collection.

This serves two crucial purposes:
1. Keeps the primary partitioned queues clean and lightning-fast.
2. Preserves the failed payload, stack trace, and error message for developers to debug exactly what broke.

### Replaying Dead Jobs

Once you've patched the underlying application bug, AsyncZap allows you to replay jobs straight from the DLQ terminal.

```bash
# Finds a dead job by ID and pushes a fresh copy back into the active queue
npx asynczap replay <job_id> -u mongodb://localhost/myapp
```

For mass replays, use the rate-limited programmatic API to prevent queue saturation:

```typescript
const result = await queue.replay.replayAllFailedJobs({
  batchSize: 100,              // Process 100 jobs per batch
  delayBetweenBatchesMs: 1000  // 1s pause between batches
});
console.log(`Replayed ${result.replayed} of ${result.total} failed jobs`);
```

You can also use the programmatic Replay UI inside the Web Dashboard.
