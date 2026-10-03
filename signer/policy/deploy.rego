# 배포 직전에 배포 증명서(in-toto Statement)가 지켜야 하는 조건.
# 정책 판단(어디에 배포해도 되는지)은 policy/ 가 하고, 여기는 서명된 결과가 그 판단과 승인 규칙을 벗어나지 않았는지만 봄
# cosign verify-attestation --type https://hibiscus.lth.so/attestations/deploy-decision/v1 --policy deploy.rego 로 씀
package signature

default allow = false

predicate := input.predicate

allow {
	input.predicateType == "https://hibiscus.lth.so/attestations/deploy-decision/v1"
	count(input.subject) > 0
	valid_decision
	valid_targets
	valid_approval
}

# block 은 서명하지 않음
valid_decision {
	predicate.decision == "allow"
}

valid_decision {
	predicate.decision == "needs_approval"
}

# 배포 위치는 아는 곳만, 하나 이상
known_targets := {"onprem", "cloud_run"}

valid_targets {
	count(predicate.targets) > 0
	not unknown_target
}

unknown_target {
	target := predicate.targets[_]
	not known_targets[target]
}

# 정책이 허용(allow)한 것만 사람 승인 없이 자동 서명
valid_approval {
	predicate.decision == "allow"
	predicate.approver == "auto"
	predicate.approval_sha256 == "none"
}

# 승인이 필요하면 요청자가 아닌 사람이 승인하고, 그 승인 기록 해시가 있어야 함 (아이디 대소문자 무시)
valid_approval {
	predicate.decision == "needs_approval"
	lower(predicate.approver) != "auto"
	lower(predicate.approver) != lower(predicate.requester)
	predicate.approval_sha256 != "none"
}
