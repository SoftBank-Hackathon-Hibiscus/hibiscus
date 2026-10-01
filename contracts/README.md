# contracts — 파트 사이 공개 계약

파트 사이에 JSON 파일로 오가는 데이터의 **공개 계약(published contract)**. 다른 파트가 "내가 받는 파일 / 내가 만드는 파일의 형식"을 확인할 때 보는 곳이다.

- **구현 원본(source of generation)** 은 각 파트의 zod 스키마다 (`policy/src/schema.ts`, `signer/src/schema.ts`). 각 파트가 `npm run contracts` 로 JSON Schema 를 생성한다.
- **이 폴더는 그 생성물의 공개본**이다. 담당 파트 폴더의 파일을 바이트 그대로 복사해 둔다. 여기서 손으로 고치지 않는다.
- 형식은 JSON Schema draft 2020-12. TypeScript 는 ajv(`Ajv2020`), Python 은 `jsonschema.Draft202012Validator` 로 검증할 수 있다.

## 계약 목록

| 파일 | 만드는 쪽 → 쓰는 쪽 | 담당 | 구현 원본 | 상태 |
|---|---|---|---|---|
| [`Plan.schema.json`](Plan.schema.json) (plan.json) | 정책 엔진 → 서명 파트(승인·서명), 배포 파트(targets, failover_allowed) | 류진 | `policy/src/schema.ts` `PlanSchema` | 사용 중 |
| [`DecisionLog.schema.json`](DecisionLog.schema.json) (decisions.jsonl 한 줄) | 정책 엔진·롤백 판단 → 사람(발표·감사), 대시보드 | 류진 | `policy/src/schema.ts` `DecisionLogSchema` | 사용 중 (아래 안내 참고) |
| [`RollbackRequest.schema.json`](RollbackRequest.schema.json) (rollback_request.json) | 배포 파트 → 롤백 판단 (`policy/src/rollback/cli.ts`) | 류진 | `policy/src/schema.ts` `RollbackRequestSchema` | consumer integration pending (배포 쪽 연결 전) |
| [`RollbackPlan.schema.json`](RollbackPlan.schema.json) (rollback_plan.json) | 롤백 판단 → 배포 파트 (실제 롤백 실행) | 류진 | `policy/src/schema.ts` `RollbackPlanSchema` | consumer integration pending (배포 쪽 연결 전) |
| [`SignResult.schema.json`](SignResult.schema.json) (sign_result.json) | 서명 파트 → 배포 파트 | 승표 | `signer/src/schema.ts` `SignResultSchema` | 사용 중 |
| [`SignLog.schema.json`](SignLog.schema.json) (decisions.jsonl `kind: sign` 한 줄) | 서명 파트 → 사람(감사) | 승표 | `signer/src/schema.ts` `SignLogSchema` | 사용 중 |

필드 설명과 예시는 각 파트 문서에 있다: [`policy/contracts/README.md`](../policy/contracts/README.md), [`signer/README.md`](../signer/README.md).

### DecisionLog 안내

`decisions.jsonl` 은 한 줄에 결정 하나이고 `kind` 로 구분한다. 지금 `DecisionLog.schema.json` 은 `kind: deploy` 와 `kind: rollback` 두 줄만 정의한다. 서명 파트가 쓰는 `kind: sign` 줄은 `SignLog.schema.json` 으로 검사한다. 다음 단계에서 `DecisionLog` 에 세 번째 종류로 합칠 예정이다. 그 전까지 파일 전체를 검사하려면 줄마다 `kind` 를 읽고 스키마를 골라야 한다.

## 공통 값 규칙

한 번의 파이프라인 실행 안에서 모든 파일이 같은 값을 그대로 전달한다. 각 스키마에 같은 규칙이 들어 있다 (공통 정의 파일은 아직 없다).

| 값 | 규칙 | 비고 |
|---|---|---|
| `run_id` | `^[A-Za-z0-9._-]{1,64}$` | 테스트 파트가 정하고 끝까지 그대로 전달 |
| `digest` | `^sha256:[0-9a-f]{64}$` | 컨테이너 이미지 지문. 테스트한 이미지 = 결정한 이미지 = 서명·배포할 이미지 |
| `source_revision` | `^[0-9a-f]{7,40}$`, 선택 | 테스트한 소스의 커밋 SHA. 입력에 있을 때만 출력에 실린다 |
| `plan_hash` | `^[0-9a-f]{64}$` | 접두어 없는 hex 64자. `sha256:` 을 붙이지 않는다 |
| `targets` | `string[]` | 현재 enum 없음. 사용 값은 `onprem`, `cloud_run` 뿐이며 `policy/policy.yaml` 의 `known_targets` 가 정한다 |
| `time`, `signed_at`, `approved_at` | string | ISO 8601 시각. 패턴 검사는 없다 |

## 아직 없는 계약

| 계약 | 올라오는 조건 |
|---|---|
| TestResult (test_result.json) | PR #12 (policy/parity-adapter) 머지 후. `facts.conditions` 가 거기서 바뀐다. 그 전까지는 [`policy/contracts/TestResult.schema.json`](../policy/contracts/TestResult.schema.json) 참고 |
| deploy_result | PR #9 (deploy/cloudrun-coordinator) 머지와 필드 확정 후 |
| parity handoff (인계 묶음) | 제안 형식. 레지스트리 digest 전달 방식이 정해지면 |
| env_report | 지금은 premortem 모듈 내부 계약 (`parity/premortem/schemas/`). 변환기 입력으로 쓰기로 하면 |
| 온프레 job/result | 조율기와 온프레 에이전트의 연결 방식이 정해지면 |

## 기존 경로 안내

- 서명 파트는 당분간 `policy/contracts/Plan.schema.json` 을 런타임에 직접 읽는다 (`signer/src/plan.ts`, `--plan-schema` 로 바꿀 수 있음). 그 파일이 없으면 서명하지 않는다.
- 그래서 각 파트 폴더의 `contracts/` 는 지우지 않는다. 이 폴더와 내용이 같다는 것을 테스트가 확인한다 (`policy/tests/root-contracts.test.ts`).

## 바꿀 때 절차

1. 담당 파트의 zod 스키마를 고친다.
2. 그 파트에서 `npm run contracts` 로 생성한다 (파트 테스트가 생성물이 최신인지 확인한다).
3. 생성된 파일을 이 폴더에 바이트 그대로 복사한다.
4. PR 을 올린다. 커밋 scope 는 `contracts` (예: `feat(contracts): add kind sign to DecisionLog`).
5. Slack 채널에 무엇이 바뀌었고 어느 파트가 영향을 받는지 공유한다.

## 호환성 원칙

- **선택 필드 추가**는 할 수 있다. 입력 계약(test_result, pii, rollback_request)은 모르는 필드가 있어도 받는다.
- **출력 계약**(plan, rollback_plan, decisions.jsonl, sign_result)은 `additionalProperties: false` 다. 필드를 추가하면 쓰는 쪽의 검증이 거부하므로, 스키마 변경과 쓰는 쪽 반영을 같은 PR 묶음으로 올린다.
- **필드 삭제, 이름 변경, enum 값 삭제**는 바로 하지 않는다. 새 필드나 값을 먼저 추가하고, 모든 파트가 옮긴 뒤 다음 단계에서 지운다.
- **선택 필드는 "없을 수 있다"** 는 뜻이다. 값이 없으면 `null` 대신 키를 생략한다. 스키마에 `null` 이 명시된 필드(예: `rollback_plan.serve_digest`, `SignLog` 의 `approver`·`reason`·`signature_ref`)만 예외다.

## 변경 기록

| 날짜 | PR | 내용 |
|---|---|---|
| 2026-10-01 | contracts/publish-current | main 의 Plan, RollbackRequest, RollbackPlan, DecisionLog, SignResult, SignLog 를 그대로 공개 |
