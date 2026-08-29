#!/bin/bash
# 추적표 · 이슈 · 스레드 · 게이트웨이 바인딩을 한 번에 대조한다.
#
# 고치지 않는다. 어긋난 곳만 말한다. 상태를 바꾸는 것은 각 표면을 맡은 도구의
# 몫이고, 대조기가 함께 고치면 무엇이 왜 바뀌었는지 아무도 알 수 없게 된다.
#
# 설정
#   GATEWAY_CONFIG          런타임 설정 (기본 .runtime/gateway.json)
#                           모양은 ops/gateway/gateway.config.sample.json
#   GATEWAY_SESSION_CONFIG  게이트웨이 바인딩이 든 설정 (선택)
#
# 종료코드 0=일치, 1=불일치, 2=조회 실패
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/gateway-env.sh"

config="${GATEWAY_CONFIG:-.runtime/gateway.json}"
[ -r "$config" ] || { echo "config_unreadable: $config"; exit 2; }
jq -e . "$config" >/dev/null 2>&1 || { echo "config_not_json: $config"; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "gh_missing"; exit 2; }

cfg() { jq -r --arg k "$1" '.[$k] // ""' "$config"; }
guild="$(cfg guild_id)"; channel="$(cfg channel_id)"
tracker="$(cfg tracker)"; token_file="$(cfg token_file)"
session_config="${GATEWAY_SESSION_CONFIG:-$(cfg session_config)}"
for v in guild channel tracker token_file; do
	[ -n "${!v}" ] || { echo "config_missing: $v"; exit 2; }
done
[ -r "$tracker" ]    || { echo "tracker_unreadable: $tracker"; exit 2; }
[ -r "$token_file" ] || { echo "token_file_unreadable: $token_file"; exit 2; }
[ -n "$session_config" ] && [ -r "$session_config" ] || session_config="$config"
tok="$(tr -d '\r\n' < "$token_file")"
ua="${GATEWAY_USER_AGENT:-naia-pj-adk gateway audit}"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
api() { curl -fsS -H "Authorization: Bot $tok" -H "User-Agent: $ua" "https://discord.com/api/v10/$1"; }
api "guilds/$guild/threads/active" > "$tmp/active.json" \
	|| { echo "active_fetch_failed"; exit 2; }
api "channels/$channel/threads/archived/public?limit=100" > "$tmp/archived.json" \
	|| { echo "archived_fetch_failed"; exit 2; }

# 이슈 상태는 셸에서 모아 넘긴다. 보고기 안에서 부르면 조회 실패가 조용히 "?" 가
# 되어, 물어보지 못한 것과 열려 있는 것이 구분되지 않는다.
: > "$tmp/issues.tsv"
while IFS= read -r key; do
	repo="$(jq -r --arg n "${key%%#*}" '.repositories[$n] // ""' "$config")"
	if [ -z "$repo" ]; then
		printf '%s\tUNKNOWN_REPO\n' "$key" >> "$tmp/issues.tsv"; continue
	fi
	st="$(timeout 90 gh issue view "${key##*#}" --repo "$repo" --json state --jq '.state' 2>/dev/null)"
	printf '%s\t%s\n' "$key" "${st:-LOOKUP_FAILED}" >> "$tmp/issues.tsv"
done < <(jq -r '.items[] | select(.key) | .key' "$tracker")

python3 "$here/audit-report.py" "$tracker" "$session_config" "$tmp" "$channel"
