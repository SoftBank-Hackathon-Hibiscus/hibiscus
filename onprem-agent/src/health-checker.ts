import type {
  AgentJob,
  HealthCheckResult,
  HealthProbe,
  ManagedContainer,
} from "./types.js";

export class HttpHealthChecker implements HealthProbe {
  async check(
    job: AgentJob,
    candidate: ManagedContainer,
  ): Promise<HealthCheckResult> {
    const result: HealthCheckResult = {
      run_id: job.run_id,
      target: "onprem",
      mode: "candidate",
      pass: !job.health_check.enabled,
      url: candidate.url,
      checks: [],
    };
    if (!job.health_check.enabled) return result;

    const url = new URL(candidate.url);
    url.pathname = job.health_check.path;
    url.search = "";
    url.hash = "";
    let successes = 0;
    let failures = 0;
    while (
      successes < job.health_check.success_threshold &&
      failures < job.health_check.failure_threshold
    ) {
      if (Date.now() >= Date.parse(job.deadline)) {
        result.checks.push({
          name: "health",
          pass: false,
          ms: 0,
          error: "Health check deadline reached",
        });
        break;
      }
      const started = performance.now();
      try {
        const response = await fetch(url, {
          method: job.health_check.method,
          redirect: "manual",
          signal: AbortSignal.timeout(job.health_check.timeout_seconds * 1_000),
        });
        await response.body?.cancel();
        const passed =
          response.status >= job.health_check.success_status_min &&
          response.status <= job.health_check.success_status_max;
        result.checks.push({
          name: "health",
          pass: passed,
          ms: Math.round(performance.now() - started),
          status: response.status,
        });
        const versionPassed = passed
          ? await this.checkVersion(job, candidate, result)
          : false;
        if (versionPassed) {
          successes += 1;
          failures = 0;
        } else {
          successes = 0;
          failures += 1;
        }
      } catch (error) {
        successes = 0;
        failures += 1;
        result.checks.push({
          name: "health",
          pass: false,
          ms: Math.round(performance.now() - started),
          error: error instanceof Error ? error.message : "Health check failed",
        });
      }
      if (
        successes < job.health_check.success_threshold &&
        failures < job.health_check.failure_threshold
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, job.health_check.interval_seconds * 1_000),
        );
      }
    }
    result.pass = successes >= job.health_check.success_threshold;
    return result;
  }

  private async checkVersion(
    job: AgentJob,
    candidate: ManagedContainer,
    result: HealthCheckResult,
  ): Promise<boolean> {
    if (!job.health_check.version_path) return true;

    const url = new URL(candidate.url);
    url.pathname = job.health_check.version_path;
    url.search = "";
    url.hash = "";
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(job.health_check.timeout_seconds * 1_000),
      });
      const statusPassed =
        response.status >= job.health_check.success_status_min &&
        response.status <= job.health_check.success_status_max;
      const payload = statusPassed
        ? ((await response.json()) as Record<string, unknown>)
        : undefined;
      if (!statusPassed) await response.body?.cancel();
      const passed = statusPassed && payload?.run_id === job.run_id;
      result.checks.push({
        name: "version",
        pass: passed,
        ms: Math.round(performance.now() - started),
        status: response.status,
        ...(!passed && statusPassed
          ? { error: "Version run_id does not match deployment" }
          : {}),
      });
      return passed;
    } catch (error) {
      result.checks.push({
        name: "version",
        pass: false,
        ms: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : "Version check failed",
      });
      return false;
    }
  }
}
