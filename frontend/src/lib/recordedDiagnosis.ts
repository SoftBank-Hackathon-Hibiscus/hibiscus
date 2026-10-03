import type { TestResult } from '../api/contracts';

// The recorded guestbook case: same observed failure pattern, not a diagnosis
// of this deployment. App name or pass/fail alone must not select the report.
const RECORDED_CONDITIONS = [
  { name: 'none', matched: 20, requests: [] },
  { name: 'restart', matched: 14, requests: ['11:GET /me', '12:POST /posts', '13:GET /posts', '14:GET /posts/2', '17:GET /me', '20:GET /posts'] },
  { name: 'replace', matched: 13, requests: ['11:GET /me', '12:POST /posts', '13:GET /posts', '14:GET /posts/2', '16:GET /uploads', '17:GET /me', '20:GET /posts'] },
] as const;

export function matchesRecordedGuestbook(result: TestResult): boolean {
  if (result.app !== 'parity-guestbook' || result.passed !== false) return false;
  if (result.match?.total !== 20 || result.match.matched !== 20) return false;
  const conditions = result.facts?.conditions;
  if (!conditions || conditions.length !== RECORDED_CONDITIONS.length) return false;

  return RECORDED_CONDITIONS.every((recorded) => {
    const condition = conditions.find((c) => c.name === recorded.name);
    if (!condition || condition.total !== 20 || condition.matched !== recorded.matched || condition.failed !== (recorded.matched < 20)) return false;
    const requests = condition.mismatches?.map((m) => `${m.index}:${m.request}`);
    return requests?.length === recorded.requests.length && recorded.requests.every((request) => requests.includes(request));
  });
}
