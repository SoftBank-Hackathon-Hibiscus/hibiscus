#!/usr/bin/env bash
# 지정한 revision으로 트래픽 100% 되돌리고 후보 태그를 정리한다
# 사용: rollback.sh <되돌릴 revision 이름>   예: rollback.sh hello-v1
set -euo pipefail
: "${PROJECT_ID:?PROJECT_ID 필요}" "${REGION:?REGION 필요}"
SERVICE="${SERVICE:-hello}"; TAG="${TAG:-cand}"
TO="${1:?되돌릴 revision 이름 필요}"
G=(--project="$PROJECT_ID" --region="$REGION" --quiet)

gcloud run services update-traffic "$SERVICE" "${G[@]}" --to-revisions="$TO=100" >&2
gcloud run services update-traffic "$SERVICE" "${G[@]}" --remove-tags="$TAG" >&2 || true

jq -cn --arg to "$TO" '{target:"cloud_run", phase:"rollback", result:"ok", serving:$to}'
