#!/bin/bash
# 게이트웨이 감시 부품이 실제로 막는지 확인한다. 네트워크를 쓰지 않는다.
#
# 게이트를 붙였다는 사실과 게이트가 막는다는 사실은 다르다. 실증 프로젝트에서
# 통보 경로가 한 번도 동작한 적이 없었는데 아무도 몰랐다. 그래서 이 시험은
# 통과하는 경우만이 아니라 **막혀야 하는 경우**를 함께 본다.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
ok()   { printf '  통과  %s\n' "$1"; }
bad()  { printf '  ★실패 %s — %s\n' "$1" "$2"; fail=1; }
want() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "기대=$3 실제=$2"; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/project.yaml" <<'YAML'
version: 1
discord:
  enabled: true
  contact_window:
    timezone: UTC
    days: [mon, tue, wed, thu, fri]
    start_hour: 10
    end_hour: 18
  default_responder_alias: owner
YAML

echo "== 설정 읽기 =="
GATEWAY_PROJECT_YAML="$tmp/project.yaml"; export GATEWAY_PROJECT_YAML
. "$here/contact-window.sh"
if load_contact_window; then ok "어댑터에서 읽는다"; else bad "어댑터에서 읽는다" "load 실패"; fi
want "표준시간대"   "$contact_window_tz"    "UTC"
want "요일→번호"     "$contact_window_days"  "1,2,3,4,5"
want "기본 응답자"   "$contact_window_default_responder" "owner"

echo "== 설정이 없거나 모자라면 조용히 넘어가지 않는다 =="
( GATEWAY_PROJECT_YAML="$tmp/nope.yaml" load_contact_window ) 2>/dev/null
want "없는 파일은 실패" "$?" "1"
sed '/start_hour/d' "$tmp/project.yaml" > "$tmp/partial.yaml"
( GATEWAY_PROJECT_YAML="$tmp/partial.yaml" load_contact_window ) 2>/dev/null
want "빈 칸은 실패"     "$?" "1"

echo "== 창 진리표 (UTC 월~금 10~18) =="
date() { case "$*" in "+%u") printf '%s' "$FAKE_DOW";; "+%-H") printf '%s' "$FAKE_HOUR";; *) command date "$@";; esac; }
check() { FAKE_DOW=$1 FAKE_HOUR=$2; export FAKE_DOW FAKE_HOUR
          if within_contact_window; then printf 'open'; else printf 'shut'; fi; }
want "월 09시" "$(check 1 9)"  "shut"
want "월 10시" "$(check 1 10)" "open"
want "금 17시" "$(check 5 17)" "open"
want "금 18시" "$(check 5 18)" "shut"
want "토 12시" "$(check 6 12)" "shut"
want "일 12시" "$(check 7 12)" "shut"
want "무시 스위치" "$(GATEWAY_IGNORE_HOURS=1 check 6 3)" "open"
# 재촉은 창과 같은 판정이다. 긴급 인자를 받지 않는다.
want "재촉 월 09시" "$(FAKE_DOW=1 FAKE_HOUR=9; if nudge_may_send; then printf open; else printf shut; fi)" "shut"
want "재촉 월 10시" "$(FAKE_DOW=1 FAKE_HOUR=10; if nudge_may_send; then printf open; else printf shut; fi)" "open"
unset -f date

echo "== 공용 채널 잡음 =="
is_shared_channel_noise "카나리아 접수 실패: job control receipt deadline exceeded" && ok "카나리아는 잡음" || bad "카나리아는 잡음" "놓침"
is_shared_channel_noise "[온맘 공개 페이지 응답 이상 감지] youngji:slow" && ok "단발 느림은 잡음" || bad "단발 느림은 잡음" "놓침"
is_shared_channel_noise "#394 사진 업로드가 안 됩니다" && bad "사람 장애는 잡음이 아님" "오탐" || ok "사람 장애는 잡음이 아님"

echo "== 알림 급과 펄럭임 =="
. "$here/notify-policy.sh"
want "단발 느림은 silent" "$(classify_notice one_sample_slow)" "silent"
want "정상화는 silent" "$(classify_notice recovery_of_one_sample)" "silent"
want "카나리는 silent" "$(classify_notice canary)" "silent"
want "침묵 프로브는 silent" "$(classify_notice bot_silence)" "silent"
want "재촉은 window" "$(classify_notice thread_nudge)" "window"
want "사용자 장애는 immediate" "$(classify_notice persisted_user_visible)" "immediate"
want "소켓 사망은 immediate" "$(classify_notice gateway_ws_dead)" "immediate"
( FAKE_DOW=6 FAKE_HOUR=12
  date() { case "$*" in "+%u") printf '%s' "$FAKE_DOW";; "+%-H") printf '%s' "$FAKE_HOUR";; *) command date "$@";; esac; }
  notice_may_send shared_channel one_sample_slow
  want "공용 채널에 단발 느림 금지" "$?" "1"
  notice_may_send owner_dm canary
  want "담당자 DM 에 카나리 금지" "$?" "1"
  notice_may_send owner_dm bot_silence
  want "담당자 DM 에 침묵 프로브 금지" "$?" "1"
  notice_may_send owner_dm gateway_ws_dead
  want "소켓 사망 DM 은 토요에도" "$?" "0"
  notice_may_send thread thread_nudge
  want "토요 재촉 금지" "$?" "1"
  notice_may_send thread persisted_user_visible
  want "사용자 장애는 스레드에 토요에도" "$?" "0"
  unset -f date
)
want "단발 실패는 알리지 않음" "$(flap_should_alert pass fail 1 0)" "none"
want "연속 2회는 장애" "$(flap_should_alert fail fail 2 0)" "incident"
want "그 다음 실패는 반복 안 함" "$(flap_should_alert fail fail 3 1)" "none"
want "단발 뒤 통과는 정상화 없음" "$(flap_should_alert fail pass 0 0)" "none"
want "알린 뒤에만 복구" "$(flap_should_alert fail pass 0 1)" "recovery"
led="$tmp/ledger.log"
NOTIFY_LEDGER="$led" notify_ledger_append shared_channel one_sample_slow silent suppressed testhost
grep -q 'kind=one_sample_slow' "$led" && ok "원장에 종류를 남긴다" || bad "원장에 종류를 남긴다" "없음"
grep -qiE 'token|Bot ' "$led" && bad "원장에 토큰 없음" "비밀값이 있다" || ok "원장에 토큰 없음"

echo "== 인용문의 호출 무력화 =="
# public-safety-allow: 스레드 멘션 무력화를 시험하는 가짜 Discord 식별자다. 숫자만 길어 카드번호처럼 보인다.
# public-safety-allow: 멘션 무력화를 시험하는 가짜 Discord 식별자다. 숫자만 길어 카드번호처럼 보인다.
src='대표님 @everyone 보세요 <@123456789012345678> 역할 <@&99> 그리고 @here 끝'
out="$(neutralize_mentions "$src")"
# public-safety-allow: 멘션 무력화를 시험하는 가짜 Discord 식별자다. 숫자만 길어 카드번호처럼 보인다.
for pat in '@everyone' '@here' '<@123456789012345678>' '<@&99>'; do
  if printf '%s' "$out" | grep -qF -- "$pat"; then bad "무력화 $pat" "그대로 살아 있다"; else ok "무력화 $pat"; fi
done
printf '%s' "$out" | grep -qF '> 역할' && ok "꺾쇠 보존" || bad "꺾쇠 보존" "형태가 깨졌다"

echo "== 모르면 멈춘다 =="
GATEWAY_RUNTIME_BIN="" GATEWAY_NODE_MIN=0 . "$here/gateway-env.sh"
gw_query "일부러 실패" false >/dev/null 2>&1
want "조회 실패는 0 이 아니다" "$?" "1"
gw_query "정상" printf 'x' >/dev/null 2>&1
want "정상 조회는 0"          "$?" "0"

echo "== 런타임 관문 =="
( GATEWAY_NODE_MIN=9999 . "$here/gateway-env.sh" ) >/dev/null 2>&1
want "낮은 런타임은 exit 2" "$?" "2"

echo "== 네 표면 대조 =="
mkfix() { # $1 수집디렉터리
  mkdir -p "$1"
  cat > "$1/active.json" <<'J'
{"threads":[{"id":"t-open","parent_id":"chan","name":"repo#1"},
            {"id":"t-orphan","parent_id":"chan","name":"떠도는 스레드"}]}
J
  cat > "$1/archived.json" <<'J'
{"threads":[{"id":"t-arch","name":"repo#2"}]}
J
}
sess='{"discord":{"bindings":[{"kind":"thread","threadId":"t-open"},{"kind":"thread","threadId":"t-arch"}]}}'
printf '%s' "$sess" > "$tmp/session.json"
runaudit() { # $1 추적표 $2 issues.tsv 내용 → 출력은 stdout, 종료코드 보존
  local dir="$tmp/fix"; rm -rf "$dir"; mkfix "$dir"
  printf '%b' "$2" > "$dir/issues.tsv"
  python3 "$here/audit-report.py" "$1" "$tmp/session.json" "$dir" "chan" 2>&1
}

cat > "$tmp/clean.json" <<'J'
{"version":1,"items":[
 {"key":"repo#1","state":"awaiting_user_verification","threadId":"t-open"},
 {"key":"repo#2","state":"completed","threadId":"t-arch"}]}
J
out="$(runaudit "$tmp/clean.json" 'repo#1\tOPEN\nrepo#2\tCLOSED\n')"; rc=$?
# 고아 스레드가 열려 있으므로 그것만 지적되어야 한다
printf '%s' "$out" | grep -q '열린 고아 스레드' && ok "열린 고아 스레드를 잡는다" || bad "열린 고아 스레드를 잡는다" "지적 없음"
want "고아만 있어도 불일치로 센다" "$rc" "1"

cat > "$tmp/stale.json" <<'J'
{"version":1,"items":[
 {"key":"repo#1","state":"new","threadId":"t-open"},
 {"key":"repo#2","state":"completed","threadId":"t-gone"}]}
J
out="$(runaudit "$tmp/stale.json" 'repo#1\tCLOSED\nrepo#2\tCLOSED\n')"
printf '%s' "$out" | grep -q '닫혔는데 추적표는 new' && ok "닫힌 이슈를 계속 태우는 것을 잡는다" || bad "닫힌 이슈를 계속 태우는 것을 잡는다" "지적 없음"
printf '%s' "$out" | grep -q '삭제된 스레드' && ok "사라진 스레드 식별자를 잡는다" || bad "사라진 스레드 식별자를 잡는다" "지적 없음"

cat > "$tmp/nobind.json" <<'J'
{"version":1,"items":[{"key":"repo#3","state":"dispatched","threadId":"t-nobind"}]}
J
cat > "$tmp/dummy.json" <<'J'
{"version":1,"items":[]}
J
out="$(runaudit "$tmp/nobind.json" 'repo#3\tOPEN\n')"
printf '%s' "$out" | grep -q '삭제된 스레드' && ok "바인딩 없는 미지 스레드를 잡는다" || bad "바인딩 없는 미지 스레드를 잡는다" "지적 없음"

cat > "$tmp/resolved.json" <<'J'
{"version":1,"items":[
 {"key":"repo#1","state":"completed","threadId":"t-open","closedBy":"manual_cleanup"},
 {"key":"repo#2","state":"completed","threadId":"t-arch"}]}
J
out="$(runaudit "$tmp/resolved.json" 'repo#1\tOPEN\nrepo#2\tCLOSED\n')"
printf '%s' "$out" | grep -q '후속 조치는 정리됨' && ok "사람이 정리한 것은 참고로만 센다" || bad "사람이 정리한 것은 참고로만 센다" "참고 없음"
printf '%s' "$out" | grep -q '정리 근거 없음' && bad "정리 근거가 있으면 불일치 아님" "불일치로 셌다" || ok "정리 근거가 있으면 불일치 아님"

echo
if [ "$fail" -eq 0 ]; then echo "gateway selftest passed"; else echo "gateway selftest FAILED"; fi
exit "$fail"
