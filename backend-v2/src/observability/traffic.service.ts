import { Injectable } from '@nestjs/common';
import type { TrafficSnapshot } from './types/console.type.js';

interface Aggregate {
  requests: number;
  errors: number;
  targets: Map<string, number>;
  durations: number[];
}
/** Process-local, bounded one-second buckets. Never retains request paths or bodies. */
@Injectable()
export class TrafficService {
  private readonly startedAt = Date.now();
  private readonly apps = new Map<string, Map<number, Aggregate>>();
  record(
    applicationId: string,
    targetId: string,
    status: number,
    durationMs: number,
    now = Date.now(),
  ) {
    const second = Math.floor(now / 1000);
    const buckets =
      this.apps.get(applicationId) ?? new Map<number, Aggregate>();
    const aggregate = buckets.get(second) ?? {
      requests: 0,
      errors: 0,
      targets: new Map<string, number>(),
      durations: [],
    };
    aggregate.requests++;
    if (status >= 500) aggregate.errors++;
    aggregate.targets.set(targetId, (aggregate.targets.get(targetId) ?? 0) + 1);
    // Bound latency samples independently from exact counters.
    if (aggregate.durations.length < 128)
      aggregate.durations.push(Math.max(0, durationMs));
    buckets.set(second, aggregate);
    this.apps.set(applicationId, buckets);
    for (const [id, samples] of this.apps) {
      for (const timestamp of samples.keys())
        if (timestamp < second - 900) samples.delete(timestamp);
      if (!samples.size) this.apps.delete(id);
    }
  }
  snapshot(
    applicationId: string,
    windowSeconds: number,
    now = Date.now(),
  ): TrafficSnapshot {
    const end = Math.floor(now / 1000); // Use completed seconds for a stable denominator.
    const start = Math.max(
      end - windowSeconds,
      Math.floor(this.startedAt / 1000),
    );
    const observedSeconds = Math.max(0, end - start);
    const samples = this.apps.get(applicationId);
    let requests = 0,
      errors = 0;
    const targets = new Map<string, number>();
    const durations: number[] = [];
    const bucketWidth = windowSeconds / 30;
    const buckets = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(
        (end - windowSeconds + i * bucketWidth) * 1000,
      ).toISOString(),
      requests: 0,
      errors: 0,
      requestsPerSecond: 0,
    }));
    for (const [second, sample] of samples ?? []) {
      if (second < start || second >= end) continue;
      requests += sample.requests;
      errors += sample.errors;
      durations.push(...sample.durations);
      for (const [id, count] of sample.targets)
        targets.set(id, (targets.get(id) ?? 0) + count);
      const bucket =
        buckets[Math.floor((second - (end - windowSeconds)) / bucketWidth)]!;
      bucket.requests += sample.requests;
      bucket.errors += sample.errors;
    }
    durations.sort((a, b) => a - b);
    for (const bucket of buckets)
      bucket.requestsPerSecond = bucket.requests / bucketWidth;
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      windowSeconds,
      observedSeconds,
      requests,
      errors,
      requestsPerSecond: observedSeconds ? requests / observedSeconds : 0,
      errorRate: requests ? errors / requests : 0,
      p95Ms: durations.length
        ? durations[Math.ceil(durations.length * 0.95) - 1]!
        : null,
      targets: [...targets].map(([targetId, count]) => ({
        targetId,
        requests: count,
        requestsPerSecond: observedSeconds ? count / observedSeconds : 0,
      })),
      buckets,
    };
  }
}
