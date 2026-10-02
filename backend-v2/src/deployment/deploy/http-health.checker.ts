import type { HealthCheckConfig } from '../../database/schema.js';
import type {
  DeployCheck,
  DeployTarget,
  HealthCheckerPort,
} from '../types/deploy-result.type.js';

type Fetch = (url: URL, init: RequestInit) => Promise<{ status: number }>;
type Sleep = (ms: number) => Promise<void>;

/**
 * Application 의 Health Check 설정으로 후보 주소를 검사한다. 온프레 에이전트와 같은 기준을 쓴다.
 * success_threshold 번 성공하면 통과, failure_threshold 번 실패하면 불합격.
 */
export class HttpHealthChecker implements HealthCheckerPort {
  constructor(
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
    private readonly sleep: Sleep = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async check(
    target: DeployTarget,
    baseUrl: string,
    config: HealthCheckConfig,
  ): Promise<DeployCheck> {
    const url = new URL(config.path, baseUrl);
    if (!config.enabled) {
      return {
        target,
        mode: 'candidate',
        pass: true,
        url: url.toString(),
        checker: 'http-health',
        checks: [{ name: 'health', skipped: true }],
      };
    }
    const checks: unknown[] = [];
    let successes = 0;
    let failures = 0;
    while (
      successes < config.successThreshold &&
      failures < config.failureThreshold
    ) {
      const started = Date.now();
      let status: number | null = null;
      let error: string | null = null;
      try {
        status = (
          await this.fetcher(url, {
            method: config.method,
            redirect: 'manual',
            signal: AbortSignal.timeout(config.timeoutSeconds * 1_000),
          })
        ).status;
      } catch (issue) {
        error = issue instanceof Error ? issue.message : String(issue);
      }
      const pass =
        status !== null &&
        status >= config.successStatusMin &&
        status <= config.successStatusMax;
      if (pass) successes++;
      else failures++;
      checks.push({
        name: 'health',
        pass,
        status,
        ms: Date.now() - started,
        error,
      });
      if (
        successes < config.successThreshold &&
        failures < config.failureThreshold
      )
        await this.sleep(config.intervalSeconds * 1_000);
    }
    return {
      target,
      mode: 'candidate',
      pass: successes >= config.successThreshold,
      url: url.toString(),
      checker: 'http-health',
      checks,
    };
  }
}
