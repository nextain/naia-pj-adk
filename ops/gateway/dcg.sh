#!/usr/bin/env bash
# 프로젝트 게이트웨이 CLI와 naia-adk manage-discord-sessions 사이의 운영 진입점.
# 토큰·호스트·채널 ID는 여기에 없다. 환경 변수와 추적하지 않는 런타임만 본다.
set -euo pipefail
set +x

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
adk_root="$(cd "$here/../.." && pwd)"
project_ctl="${PROJECT_GATEWAY_CTL:-}"
naia_adk_root="${NAIA_ADK_ROOT:-$adk_root/../naia-adk}"
adk_script="$naia_adk_root/.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh"
backend="${NAIA_DCG_BACKEND:-auto}"
unit="${PROJECT_GATEWAY_UNIT:-}"

args=("$@")
cmd="${args[0]:-status}"

project_alive() {
  [[ -n "$unit" ]] && systemctl --user is-active --quiet "$unit"
}

if [[ -n "$project_ctl" && -x "$project_ctl" ]]; then
  if [[ "$backend" == project ]] || { [[ "$backend" == auto ]] && project_alive; }; then
    exec "$project_ctl" "${args[@]}"
  fi
fi

if [[ "$backend" != project && -x "$adk_script" ]]; then
  exec "$adk_script" "${args[@]}"
fi

if [[ -n "$project_ctl" && -x "$project_ctl" ]]; then
  exec "$project_ctl" "${args[@]}"
fi

echo "dcg: 프로젝트 CLI(PROJECT_GATEWAY_CTL)도 naia-adk 스크립트도 없습니다." >&2
echo "명령: $cmd" >&2
exit 127
