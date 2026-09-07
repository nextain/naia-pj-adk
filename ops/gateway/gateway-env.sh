#!/bin/bash
# 게이트웨이 감시 스크립트가 도구를 부르기 전에 통과해야 하는 관문.
#
# 예약 실행 환경(systemd, cron, CI)의 탐색 경로는 대화형 셸과 다르다. 실증
# 프로젝트에서 서비스 쪽이 낮은 런타임 버전을 먼저 집어 도구가 시작하자마자
# 죽었고, 손으로 돌리면 통과하므로 만들 때의 검증도 통과했다. 이틀 동안 아흔
# 번을 실패하는 동안 한 번도 성공한 적이 없었다.
#
# 그래서 스크립트가 자기 실행 환경을 스스로 고정하고, 조건이 어긋나면 조용히
# 이어가지 말고 0 이 아닌 코드로 죽는다.
#
# 프로젝트가 정하는 값
#   GATEWAY_RUNTIME_BIN   런타임 실행 파일이 있는 디렉터리 (탐색 경로 앞에 붙는다)
#   GATEWAY_NODE_MIN      허용하는 최소 major 버전
#
# 사용
#   . "$(dirname "$0")/gateway-env.sh"

if [ -n "${GATEWAY_RUNTIME_BIN:-}" ]; then
	export PATH="$GATEWAY_RUNTIME_BIN:$PATH"
fi

# Keep the gateway floor aligned with package.json and the CI runtime contract.
GATEWAY_NODE_MIN=${GATEWAY_NODE_MIN:-20}
_gw_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "${_gw_major:-0}" -lt "$GATEWAY_NODE_MIN" ] 2>/dev/null; then
	# 조용히 이어가면 호출부가 crash 출력을 "요청 거절"로 오독한다. 시끄럽게 죽는다.
	echo "node_too_old major=${_gw_major:-none} need>=$GATEWAY_NODE_MIN path=$(command -v node || echo none)"
	exit 2
fi
unset _gw_major

# 상태 조회가 실패하면 "없음"과 "모름"이 같아진다. 모르면 멈추라는 뜻으로 쓴다.
#   value=$(gw_query "설명" 명령 인자…) || exit 2
gw_query() {
	local what="$1"; shift
	local out
	if ! out="$("$@" 2>&1)"; then
		echo "query_failed [$what]: $(printf '%s' "$out" | tr '\n' ' ' | tail -c 200)" >&2
		return 1
	fi
	printf '%s' "$out"
}
