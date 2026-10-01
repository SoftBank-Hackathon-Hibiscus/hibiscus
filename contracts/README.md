# contracts — 파트 사이 공개 계약

파트 사이에 JSON 파일로 오가는 데이터의 **공개 계약(published contract)**. 다른 파트가 "내가 받는 파일 / 내가 만드는 파일의 형식"을 확인할 때 보는 곳이다.

- **구현 원본(source of generation)** 은 각 파트의 zod 스키마다 (`policy/src/schema.ts`, `signer/src/schema.ts`). 각 파트가 `npm run contracts` 로 JSON Schema 를 생성한다.
- **이 폴더는 그 생성물의 공개본**이다. 담당 파트 폴더의 파일을 바이트 그대로 복사해 둔다. 여기서 손으로 고치지 않는다.
- 형식은 JSON Schema draft 2020-12. TypeScript 는 ajv(`Ajv2020`), Python 은 `jsonschema.Draft202012Validator` 로 검증할 수 있다.
- **이 폴더에는 파트 경계를 넘는 JSON만 둔다.** 파트 안에서만 쓰는 파일(예: PiiReport, Approval)은 각 파트 폴더에 둔다.

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
| `run_id` | `^[A-Za-z0-9._-]{1,64}$` | 파이프라인 실행 1회당 1개. 실행 시작 시 백엔드가 만들어 모든 단계에 전달하고, 각 파트는 받은 값을 그대로 쓴다 |
| `digest` | `^sha256:[0-9a-f]{64}$` | 컨테이너 이미지 지문. 테스트한 이미지 = 결정한 이미지 = 서명·배포할 이미지. 레지스트리에 올린 이미지의 digest (로컬 image ID 아님) |
| `source_revision` | `^[0-9a-f]{7,40}$` | 테스트한 소스의 커밋 SHA. 이 폴더의 계약에서는 모두 선택이고, 입력에 있을 때만 출력에 실린다. 입력 계약인 RollbackRequest 는 `"unknown"` 도 받으며 정책에서는 값 없음으로 취급한다 |
| `plan_hash` | `^[0-9a-f]{64}$` | 접두어 없는 hex 64자. `sha256:` 을 붙이지 않는다 |
| `targets` | `string[]` | 현재 스키마는 enum 없는 문자열 배열. 현재 시스템에서 쓰는 배포 대상은 `onprem`, `cloud_run`. enum 강제는 다음 단계에서 적용 예정 (정책은 실행 중에 `policy/policy.yaml` 의 `known_targets` 로 이 값을 제한한다) |
| `time`, `signed_at`, `approved_at` | string | ISO 8601 시각. 패턴 검사는 없다 |

## 아직 없는 계약

| 계약 | 만드는 쪽 → 쓰는 쪽 | 올릴 사람 | 올라오는 조건 |
|---|---|---|---|
| TestResult (test_result.json) | parity → policy | 류진 | PR #12 (policy/parity-adapter) 머지 후. `facts.conditions` 가 거기서 바뀐다. 그 전까지는 [`policy/contracts/TestResult.schema.json`](../policy/contracts/TestResult.schema.json) 참고 |
| parity handoff (인계 묶음) | parity → policy | 윤선 | 형식 확정 후 (레지스트리 digest 전달 방식 포함) |
| env_report | parity → policy | 주영 | 정책 입력으로 실제 쓰기로 하면. 지금은 premortem 모듈 내부 계약 (`parity/premortem/schemas/`) |
| deploy_result | deploy → backend | 준하 | PR #9 (deploy/cloudrun-coordinator) 머지와 필드 확정 후 |

온프레 job/result(배포 조율기 ↔ 온프레 에이전트)는 배포 파트 내부라 여기 올리지 않는다. 다른 파트가 직접 읽게 되면 그때 올린다.

## 기존 경로 안내

- 서명 파트는 당분간 `policy/contracts/Plan.schema.json` 을 런타임에 직접 읽는다 (`signer/src/plan.ts`, `--plan-schema` 로 바꿀 수 있음). 그 파일이 없으면 서명하지 않는다.
- 그래서 각 파트 폴더의 `contracts/` 는 지우지 않는다. 정책 소유 4개(Plan, DecisionLog, RollbackRequest, RollbackPlan)는 `policy/tests/root-contracts.test.ts` 가 원본과 같은지 확인한다. 서명 파트 2개(SignResult, SignLog)는 자동 검사가 없다.

## 바꿀 때 절차

1. 계약을 만드는 파트(producer)가 자기 구현 원본(zod 또는 JSON Schema)을 고친다.
2. 생성기가 있으면 계약 파일을 생성한다.
3. 파트 간 공개 계약이면 같은 PR 에서 루트 `contracts/` 도 바이트 그대로 갱신하고, 이 README 의 계약 표와 변경 기록도 고친다.
4. `contracts/` 변경은 루트 관리자(류진)가 공통 규칙·호환성을 확인한다.
   - 류진이 작성자가 아닌 PR 이면 리뷰어로 류진을 추가한다.
   - 류진이 작성한 PR 이면 다른 팀원이 리뷰한다.
5. 다른 파트가 읽는 형식이 바뀌면, 그 파트(consumer)와 먼저 형식을 맞춘 뒤 올린다.
6. Slack 채널에 무엇이 바뀌었고 어느 파트가 영향을 받는지 공유한다.

커밋 scope 는 `contracts` 다 (예: `feat(contracts): add kind sign to DecisionLog`).

## 호환성 원칙

- **선택 필드 추가**는 할 수 있다. 입력 계약(test_result, pii, rollback_request)은 모르는 필드가 있어도 받는다.
- **출력 계약**(plan, rollback_plan, decisions.jsonl, sign_result)은 `additionalProperties: false` 다. 필드를 추가하면 쓰는 쪽의 검증이 거부하므로, 스키마 변경과 쓰는 쪽 반영을 같은 PR 묶음으로 올린다.
- **필드 삭제, 이름 변경, enum 값 삭제**는 바로 하지 않는다. 새 필드나 값을 먼저 추가하고, 모든 파트가 옮긴 뒤 다음 단계에서 지운다.
- **선택 필드는 "없을 수 있다"** 는 뜻이다. 값이 없으면 `null` 대신 키를 생략한다. 스키마에 `null` 이 명시된 필드(예: `rollback_plan.serve_digest`, `SignLog` 의 `approver`·`reason`·`signature_ref`)만 예외다.

## 변경 기록

| 날짜 | PR | 내용 |
|---|---|---|
| 2026-10-01 | contracts/publish-current | main 의 Plan, RollbackRequest, RollbackPlan, DecisionLog, SignResult, SignLog 를 그대로 공개 |
