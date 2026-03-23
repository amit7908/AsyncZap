# AsyncZap ⚡

<div align="center">
  <img src="https://img.shields.io/npm/v/asynczap" alt="NPM Version" />
  <img src="https://img.shields.io/github/license/amit7908/AsyncZap" alt="License" />
  <img src="https://img.shields.io/node/v/asynczap" alt="Node Version" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-blue.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/MongoDB-Supported-green.svg" alt="MongoDB" />
</div>

<p align="center">
  <b>A production-grade, distributed job queue for Node.js built entirely on MongoDB.</b><br>
  No Redis. No Kafka. Just your existing database, scaling horizontally.
</p>

## 🚀 Why AsyncZap?

Most job queues require Redis as a separate dependency. **AsyncZap** eliminates that overhead by using MongoDB's advanced capabilities to provide a complete, distributed queueing system. It offers:

- **Distributed & Horizontally Scalable**: Automatic partitioning spreads jobs across collections to eliminate locking bottlenecks.
- **DAG Workflow Engine**: Build complex job dependencies and pipelines effortlessly.
- **Atomic Backpressure**: Prevent downstream service overload with cluster-wide concurrency limits.
- **Multi-Tenant Fairness**: Isolate customer queues and guarantee fair scheduling in SaaS products.
- **Built-in Observability**: Native Prometheus metrics, CLI tooling, and an embedded zero-dependency dashboard.

## 📦 Quick Start

### Installation

```bash
npm install asynczap
```

> **Note**: `mongoose` is required as a peer dependency. `@nestjs/common` is an optional peer dependency (only needed if using `AsyncZapModule`).

### Basic Usage

```typescript
import mongoose from 'mongoose';
import { AsyncZapQueue } from 'asynczap';

async function bootstrap() {
  await mongoose.connect('mongodb://localhost/myapp');
  
  // 1. Initialize the Queue with 4 partitions
  const queue = new AsyncZapQueue(mongoose.connection, { partitions: 4 });
  await queue.initialize();

  // 2. Enqueue a Job
  const job = await queue.add('send-email', { to: 'user@example.com' });
  console.log(`Job enqueued: ${job._id}`);

  // 3. Start a Worker Worker
  const worker = queue.createWorker({ partitions: [0, 1, 2, 3] });
  worker.process('send-email', async (job) => {
    console.log(`Sending email to ${job.payload.to}`);
  });
  
  await worker.start();
}
bootstrap();
```

## ✨ Feature Highlights

| Feature | Description |
| ------- | ----------- |
| 🛡️ **Idempotency** | Prevent duplicate jobs with unique idempotency keys. |
| 🔁 **Retries & DLQ** | Automatic exponential backoff retries and Dead Letter Queue. |
| ⏱️ **Job Scheduling** | Schedule jobs to execute securely in the future. |
| 🏎️ **Turbo Mode** | High-throughput batch prefetching capabilities. |
| 📈 **Prometheus Integration** | Exposed endpoint returning industry-standard metrics. |
| 🔌 **NestJS Module** | Optional `@nestjs/common` integration (`AsyncZapModule`). |

## 📐 Architecture Overview

AsyncZap uses **Deterministic Hashing** to distribute jobs across multiple MongoDB collections (`asynczap_jobs_0`, `asynczap_jobs_1`, etc.). Workers independently poll assigned partitions, achieving zero cross-worker lock contention.

Read more in our [Architecture Guide](https://github.com/amit7908/AsyncZap/blob/main/docs/architecture.md).

## 🚀 Performance & Benchmarks

Compared directly to Single-Collection queues, AsyncZap's bulk enqueuing is highly optimized.
*Tested against Atlas M0 Cloud Database:*

- **Bulk Enqueue**: ~871 jobs/second (174x faster than sequential)
- **Scaling**: Linearly scales by setting `n` partitions and `w` workers.

Read the [Full Benchmark Results](https://github.com/amit7908/AsyncZap/blob/main/docs/benchmarks.md).

## ⚔️ Comparison

| Feature | BullMQ | Agenda | **AsyncZap** |
|---------|--------|--------|-------------|
| Backing Store | Redis | MongoDB | **MongoDB** |
| Partitioning | ❌ | ❌ | **✅ N-way** |
| DAG Workflows | ❌ | ❌ | **✅ Built-in** |
| Multi-Tenancy | ❌ | ❌ | **✅ Fair scheduling** |
| Backpressure | Manual | ❌ | **✅ Atomic counters** |
| Prometheus | External | ❌ | **✅ Native** |

## 📚 Documentation

Dive deeper into our specific comprehensive guides:

- [Architecture & Design](https://github.com/amit7908/AsyncZap/blob/main/docs/architecture.md)
- [Building DAG Workflows](https://github.com/amit7908/AsyncZap/blob/main/docs/workflows.md)
- [Working with Multi-Tenancy](https://github.com/amit7908/AsyncZap/blob/main/docs/multi-tenancy.md)
- [System Backpressure Management](https://github.com/amit7908/AsyncZap/blob/main/docs/backpressure.md)
- [Retries and Dead Letter Queues (DLQ)](https://github.com/amit7908/AsyncZap/blob/main/docs/retry-and-dlq.md)
- [Benchmarks](https://github.com/amit7908/AsyncZap/blob/main/docs/benchmarks.md)

## 🖥️ CLI & Dashboard

AsyncZap comes with an embedded dashboard and a CLI.

```bash
npx asynczap dashboard -u mongodb://localhost/myapp -p 3000
```

Optionally secure the API with a bearer token:
```bash
npx asynczap dashboard -u mongodb://localhost/myapp -p 3000 --token my-secret
```
Then visit `http://localhost:3000`.

To view stats in terminal:
```bash
npx asynczap stats -u mongodb://localhost/myapp
```

## 🤝 Contributing

We welcome contributions! Please review our [Contributing Guide](https://github.com/amit7908/AsyncZap/blob/main/CONTRIBUTING.md) and [Code of Conduct](https://github.com/amit7908/AsyncZap/blob/main/CODE_OF_CONDUCT.md) before opening a PR.

## 📜 License

This project is licensed under the [MIT License](https://github.com/amit7908/AsyncZap/blob/main/LICENSE).
