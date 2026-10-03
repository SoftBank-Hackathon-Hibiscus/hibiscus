export interface TrafficBucket {
  timestamp: string;
  requests: number;
  errors: number;
  requestsPerSecond: number;
}
export interface TrafficSnapshot {
  startedAt: string;
  windowSeconds: number;
  observedSeconds: number;
  requests: number;
  requestsPerSecond: number;
  errors: number;
  errorRate: number;
  p95Ms: number | null;
  targets: Array<{
    targetId: string;
    requests: number;
    requestsPerSecond: number;
  }>;
  buckets: TrafficBucket[];
}
export interface RuntimeLogEntry {
  id: string;
  timestamp: string;
  stream: 'stdout' | 'stderr';
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
}
