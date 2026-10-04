import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrafficService } from '../traffic.service.js';
describe('gateway traffic', () => {
  afterEach(() => vi.useRealTimers());
  it('counts completed requests and 5xx, separates target rates and excludes out-of-window samples', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    const service = new TrafficService();
    const start = Date.now();
    service.record('app', 'onprem', 200, 10, start + 1000);
    service.record('app', 'cloud', 502, 30, start + 1000);
    service.record('other', 'onprem', 200, 100, start + 1000);
    let snapshot = service.snapshot('app', 60, start + 11_000);
    expect(snapshot.requests).toBe(2);
    expect(snapshot.requestsPerSecond).toBeCloseTo(2 / 11);
    expect(snapshot.errorRate).toBe(0.5);
    expect(snapshot.p95Ms).toBe(30);
    expect(snapshot.buckets.reduce((sum, b) => sum + b.requests, 0)).toBe(2);
    expect(snapshot.targets).toHaveLength(2);
    snapshot = service.snapshot('app', 60, start + 62_000);
    expect(snapshot.requests).toBe(0);
    expect(snapshot.p95Ms).toBeNull();
    expect(snapshot.requestsPerSecond).toBe(0);
  });
  it('does not count current incomplete second in the rate denominator', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T00:00:00Z'));
    const service = new TrafficService();
    const start = Date.now();
    service.record('app', 'target', 200, 1, start + 2000);
    expect(service.snapshot('app', 60, start + 2500).requests).toBe(0);
    expect(service.snapshot('app', 60, start + 3000).requests).toBe(1);
  });
});
