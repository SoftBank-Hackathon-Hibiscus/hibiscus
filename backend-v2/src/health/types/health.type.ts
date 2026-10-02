export interface TargetProbeResult {
  status: 'healthy' | 'unhealthy';
  reason: string;
  failureKind?: 'application' | 'network';
}
