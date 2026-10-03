# 회사별로 바꿔 끼우는 엄격한 배포 조건 예시. deploy.rego 조건에 아래를 더함
# - 시험 결과가 증명서에 있고, 통과했고, 모든 조건(정상·재시작·교체)에서 기록과 같았음
# - 개인정보 규칙(R4, policy/policy.yaml)이 걸린 앱은 Cloud Run 금지, 장애 때도 안 넘김
# - 사람 승인은 서명 1시간 안에 받은 것만 (오래된 승인 재사용 금지)
# 쓰는 법: npm run verify -- --result sign_result.json --attestation --policy policy/strict.rego
package signature

default allow = false

predicate := input.predicate

allow {
	input.predicateType == "https://hibiscus.lth.so/attestations/deploy-decision/v1"
	count(input.subject) > 0
	valid_decision
	valid_targets
	valid_approval
	tested
	pii_stays_onprem
	fresh_approval
}

valid_decision {
	predicate.decision == "allow"
}

valid_decision {
	predicate.decision == "needs_approval"
}

known_targets := {"onprem", "cloud_run"}

valid_targets {
	count(predicate.targets) > 0
	not unknown_target
}

unknown_target {
	target := predicate.targets[_]
	not known_targets[target]
}

valid_approval {
	predicate.decision == "allow"
	predicate.approver == "auto"
	predicate.approval_sha256 == "none"
}

valid_approval {
	predicate.decision == "needs_approval"
	lower(predicate.approver) != "auto"
	lower(predicate.approver) != lower(predicate.requester)
	predicate.approval_sha256 != "none"
}

# 시험 결과: 있어야 하고, 통과, 조건마다 전부 일치
tested {
	predicate.test.passed == true
	predicate.test.match.matched == predicate.test.match.total
	not condition_failed
}

condition_failed {
	c := predicate.test.conditions[_]
	c.matched != c.total
}

# 개인정보 규칙(R4)이 걸렸으면 온프레만, 장애 전환도 금지
pii {
	predicate.matched_rules[_] == "R4"
}

pii_stays_onprem {
	not pii
}

pii_stays_onprem {
	pii
	not cloud_target
	predicate.failover_allowed == false
}

cloud_target {
	predicate.targets[_] == "cloud_run"
}

# 사람 승인은 서명 1시간 안. 자동 승인은 해당 없음
fresh_approval {
	predicate.decision == "allow"
}

fresh_approval {
	predicate.decision == "needs_approval"
	approved := time.parse_rfc3339_ns(predicate.approved_at)
	signed := time.parse_rfc3339_ns(predicate.signed_at)
	signed >= approved
	signed - approved <= 3600 * 1000000000
}
