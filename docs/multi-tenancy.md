# Multi-Tenancy

In Software as a Service (SaaS), you often have multiple customers (tenants) submitting jobs into a shared queue. A common failure pattern is **Tenant Starvation** — where one heavy user submits 10,000 jobs, blocking all other users from executing their jobs.

AsyncZap provides immediate protection through the `TenantScheduler`.

## Setting Tenant Limits

You can specify the maximum number of **concurrently executing** jobs at a per-tenant level.

```typescript
// Allow Tenant A to process at most 10 jobs simultaneously
await queue.tenantScheduler.setTenantLimit('tenant-A', 10);

// Allow Tenant B to process at most 50 jobs simultaneously
await queue.tenantScheduler.setTenantLimit('tenant-B', 50);
```

## Adding Multi-Tenant Jobs

Assign the `tenantId` in the job options.

```typescript
await queue.add('video-render', payload, { tenantId: 'tenant-A' });
```

## How It Works Under the Hood

When a worker pulls a job, it evaluates the `tenantId` against the active tenant counter stored in MongoDB.
1. If the tenant has not reached their currency slice, the job proceeds.
2. If the tenant **has** reached their limit, AsyncZap immediately releases the lock, increments wait counters, and skips the job, allowing the worker to seamlessly pull the next available job from another tenant.
