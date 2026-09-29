# policy-engine — 정책 엔진

증명 기반 하이브리드 배포 서비스의 2단계(보안·결정) 중 **정책 엔진** 모듈.

> 테스트 판정 결과 + 개인정보 후보 → `policy.yaml` 규칙 → 배포 허용/차단 + 배포 위치 → `plan.json`

- 결정은 AI가 아니라 **규칙**이 한다. 같은 입력이면 항상 같은 `plan.json`(같은 `plan_hash`)이 나온다.
- 규칙은 코드가 아니라 `policy.yaml`에 있다. 엔진은 규칙 "내용"을 모르고 작은 조건 문법만 해석한다.
- 다른 모듈과는 JSON 파일로만 주고받는다. `digest`, `run_id`는 입력에서 출력까지 그대로 전달된다.
- 모든 결정은 `decisions.jsonl`에 한 줄씩 **추가만** 한다.

## 실행

```bash
npm install
npx tsx src/cli.ts --test test_result.json --pii pii.json --policy policy.yaml --out plan.json
```

| 옵션 | 설명 |
|---|---|
| `--test` | 테스트 판정 결과 JSON (필수) |
| `--pii` | 개인정보 후보 JSON (필수) |
| `--policy` | 정책 YAML (필수) |
| `--out` | 출력할 `plan.json` 경로 (필수) |
| `--log` | 결정 기록 파일. 기본 `./decisions.jsonl` |

입력 파일 형식이 틀리면 어떤 필드가 왜 틀렸는지 출력하고 종료 코드 1로 끝난다. 결정 결과(`block` 포함)는 정상 처리이므로 종료 코드 0이다.

```bash
npm test        # vitest: fixtures 4세트 + run_id 불일치 + 결정성 + 정책 스키마
npm run demo    # fixtures 4세트를 모두 돌려 out/ 에 plan 과 decisions.jsonl 생성
npm run typecheck
```

## 입력

### `test_result.json` (테스트 파트가 만듦)

```json
{
  "run_id": "r-001",
  "app": "todo",
  "digest": "sha256:abc",
  "passed": true,
  "match": { "total": 20, "matched": 20 },
  "failures": [],
  "facts": { "writes_local_file": ["/app/data.db"], "db": "sqlite" }
}
```

### `pii.json` (개인정보 후보. 지금은 가짜 파일, 나중에 AI 판정 결과)

```json
{
  "run_id": "r-001",
  "pii": [
    { "table": "users", "column": "contact", "kind": "phone",
      "evidence": "src/routes/signup.js:24", "confident": true }
  ]
}
```

### `policy.yaml`

규칙은 위에서부터 차례로 검사한다. 각 규칙은 `id`, `if`, `then`, `reason`을 가진다.

```yaml
version: 1
rules:
  - id: R1
    if: { path: test.passed, eq: false }
    then: { decision: block }
    reason: "테스트 실패 ({test.match.matched}/{test.match.total} 일치)"
  - id: R4
    if: { some: pii.pii }
    then: { targets: [local], failover_allowed: false }
    reason: "개인정보({column}, {kind}) 발견: {evidence}"
default:
  targets: [local, cloud_run]
  failover_allowed: true
```

**조건 문법** (컨텍스트는 `{ test: test_result.json, pii: pii.json }`)

| 조건 | 뜻 |
|---|---|
| `{ path, eq / ne / in / gt / lt / exists }` | 값 비교 |
| `{ path, eq_path / ne_path }` | 두 필드 비교 (예: `test.run_id` vs `pii.run_id`) |
| `{ some: <배열 경로>, where?: <조건> }` | 배열 원소 중 조건을 만족하는 것이 있는가. `where` 안에서는 원소가 기준, `$.`로 루트 접근 |
| `{ all: [...] }` / `{ any: [...] }` / `{ not: ... }` | 논리 결합 |

**효과(`then`)**: `decision: block | needs_approval`, `targets: [...]`, `failover_allowed: bool`. 적지 않은 키는 바꾸지 않는다.

**병합 규칙**
- `decision`은 `allow < needs_approval < block` 순으로 강한 쪽만 남는다.
- `block`이 나오면 그 즉시 멈춘다. 이후 규칙은 `plan.rules`에 실리지 않는다.
- `targets` / `failover_allowed`는 나중 규칙이 덮어쓴다. 어떤 규칙도 `targets`를 정하지 않으면 `default`를 쓰고 `rules`에 `id: default`로 기록한다.

**`reason` 템플릿**: `{경로}`를 값으로 치환한다. `some`에 걸린 원소가 있으면 원소마다 렌더링해 `; `로 잇는다. 경로는 원소 → 루트 순으로 찾고, `{$.경로}`는 항상 루트.

기본 `policy.yaml`의 R1~R4는 가상 플랫폼팀의 예시다. 엔진 코드를 고치지 않고 파일만 바꿔 다른 회사 정책을 쓸 수 있다 (`tests/engine.test.ts`의 "sqlite면 local만" 테스트 참고).

## 출력

### `plan.json`

```json
{
  "run_id": "r-004",
  "app": "todo",
  "digest": "sha256:d4e5...",
  "decision": "needs_approval",
  "targets": ["local"],
  "failover_allowed": false,
  "rules": [
    { "id": "R1", "result": "not_matched" },
    { "id": "R2", "result": "not_matched" },
    { "id": "R3", "result": "matched", "reason": "확신 없는 개인정보 후보(todos.note, free_text_maybe_address): src/routes/todos.js:41" },
    { "id": "R4", "result": "matched", "reason": "개인정보(contact, phone) 발견: src/routes/signup.js:24; ..." }
  ],
  "plan_hash": "7ecaf343..."
}
```

- `decision`: `allow` | `block` | `needs_approval`
- `targets`: `block`이면 빈 배열
- `rules`: 평가된 모든 규칙과 결과. `matched`인 것만 `reason`이 있다
- `plan_hash`: `{ inputs: {test, pii}, policy, plan(해시 제외) }`를 키 정렬 JSON으로 만든 뒤 sha256. 입력·정책·결과 중 하나라도 바뀌면 달라진다

### `decisions.jsonl` (한 줄씩 추가만)

```json
{"time":"2026-09-29T13:40:02.172Z","run_id":"r-004","digest":"sha256:d4e5...","decision":"needs_approval","targets":["local"],"rule_ids":["R3","R4"],"plan_hash":"7ecaf343..."}
```

`rule_ids`는 걸린 규칙만. 시간 값은 CLI에서만 붙이고 엔진(`decide`)은 시간을 쓰지 않는다.

## 폴더

```
src/schema.ts        zod 스키마 + 타입 (입력 2개, policy, plan, 기록)
src/engine.ts        decide(test, pii, policy) -> plan   순수 함수, 파일 입출력 없음
src/cli.ts           파일 읽기/검증/쓰기, decisions.jsonl 추가
policy.yaml          규칙 (가상 회사 예시)
fixtures/01-allow             정상            -> allow, local + cloud_run
fixtures/02-block-test-failed 테스트 실패      -> block
fixtures/03-pii-confident     개인정보 확신    -> allow, local 만, failover 금지
fixtures/04-pii-unconfident   개인정보 불확실  -> needs_approval
tests/engine.test.ts vitest
scripts/demo.mjs     fixtures 일괄 실행
```

## 다른 모듈과의 연결

- **입력**: 테스트 파트의 `test_result.json`, (다음 단계) AI 개인정보 판정의 `pii.json`
- **출력**: `plan.json` → 서명 파트 (사람 승인은 `decision: needs_approval`일 때), → 배포 파트 (`targets`, `failover_allowed`)
- 모노레포로 옮길 때 이 폴더를 통째로 옮기면 된다. 외부 의존성은 `zod`, `yaml` 둘뿐이다.
