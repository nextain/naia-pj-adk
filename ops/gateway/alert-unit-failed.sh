#!/bin/bash
# 감시 유닛이 실패했다는 사실 자체를 알린다.
#
# 감시기의 소식을 듣는 유일한 경로가 감시기 자신이면, 그것의 죽음은 좋은 소식과
# 구분되지 않는다. 실증 프로젝트에서 여섯 유닛 중 넷에 이 경로가 없었고, 배분기가
# 아흔 번 연속 실패하는 동안 아무도 몰랐다.
#
# 붙였다는 사실과 도착한다는 사실은 다르다. 그 프로젝트의 기존 알림은 한 번도
# 도착한 적이 없었다. 첨부 파일을 임시 디렉터리에 만들었는데 도구가 상위 디렉터리
# 소유자를 보고 거절했고, 그 오류를 무시 구문이 삼켰다. 그래서 여기서는 삼키지
# 않는다.
#
#   alert-unit-failed.sh <실패한-유닛명>
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/gateway-env.sh"

unit="${1:-<unknown unit>}"
config="${GATEWAY_CONFIG:-.runtime/gateway.json}"
[ -r "$config" ] || { echo "config_unreadable: $config"; exit 2; }
cfg() { jq -r --arg k "$1" '.[$k] // ""' "$config"; }

dm="$(cfg operator_dm_channel_id)"
mention="$(cfg alert_mention)"
alert_dir="$(cfg alert_dir)"
send_cmd="$(cfg send_command)"
for v in dm alert_dir send_cmd; do
	[ -n "${!v}" ] || { echo "config_missing: $v"; exit 2; }
done

# 첨부의 상위 디렉터리 소유자까지 검사하는 도구가 있다. 공용 임시 디렉터리를 쓰면
# 거절당한다.
mkdir -p "$alert_dir" && chmod 700 "$alert_dir" || { echo "alert_dir_unusable: $alert_dir"; exit 2; }
msg="$(mktemp "$alert_dir/unit-failed-XXXXXX")"; chmod 600 "$msg"
trap 'rm -f "$msg"' EXIT
{
	echo "🚨 ${mention} 감시 유닛이 실패했습니다: \`$unit\`"
	echo
	echo "유닛이 0 이 아닌 코드로 끝났습니다. 이 유닛이 맡은 일은 지금 멈춰 있습니다."
	echo
	echo "최근 로그:"
	journalctl --user -u "$unit" -n 12 --no-pager 2>/dev/null | tail -12
} > "$msg"

# 삼키지 않는다. 알림이 못 나간 것을 모르면 감시가 없는 것과 같다.
if ! out="$(eval "$send_cmd" 2>&1)"; then
	echo "alert_send_failed unit=$unit: $(printf '%s' "$out" | tr '\n' ' ' | tail -c 200)"
	exit 1
fi
echo "alert_sent unit=$unit"
