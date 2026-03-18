# Workflows & Directed Acyclic Graphs (DAG)

AsyncZap has a built-in `WorkflowEngine` that allows you to define complex dependencies between jobs.

## What is a DAG?

A Directed Acyclic Graph is a series of jobs that run in a specific order, where some jobs must **wait** for others to finish before they execute.

### The Diamond Pattern
```text
      A
    /   \
   B     C
    \   /
      D
```
In this pattern, job `D` waits for both `B` and `C` to finish. Job `B` and `C` both start concurrently after `A` finishes.

## How to Create a Workflow

```typescript
import { WorkflowEngine } from 'asynczap';

const workflow = new WorkflowEngine(queue);

const jobsCreated = await workflow.createWorkflow({
  'stepA': { job: 'fetch-data', payload: { source: 'api' } },
  'stepB': { job: 'transform', dependsOn: ['stepA'] },
  'stepC': { job: 'validate', dependsOn: ['stepA'] },
  'stepD': { job: 'load', dependsOn: ['stepB', 'stepC'] }
});
```

The engine automatically provisions all jobs into MongoDB in a single atomic database operation. Each job stores a `remainingDependencies` counter.
When a worker finishes `stepA`, it will automatically decrement the dependency count of its children `stepB` and `stepC`.
When `stepD`'s dependency count drops to `0`, it instantly unlocks and is processed.
