#!/bin/bash
# 사람에게 확인을 요청해도 되는 시간, 그리고 누구를 부를지.
#
# default_responder_alias 가 비어 있는 것이 기본이다. 비어 있으면 확인 재촉이
# 배포 담당자에게 기본 낙하하지 않는다. 값을 채우더라도 우리 차례 침묵을
# 그 사람에게 올리는 용도가 아니다.
#
# 고장 알림과 확인 요청은 다른 것이다. 고장은 언제 일어나든 알려야 하지만
# "확인해 주세요"는 상대가 일하는 시간에만 의미가 있다. 밤과 주말에 한 시간마다
# 울리는 요청은 답을 앞당기지 못하고 그 채널을 무시하는 법만 가르친다.
# 프로브·카나리·단발 느림을 고장으로 넣으면 이 창이 빈다. 급은 notify-policy.sh.
#
# 시각은 코드가 아니라 프로젝트 어댑터에서 온다. `projects/<project>/project.yaml`
# 의 `discord.contact_window` 를 그대로 읽는다.
#
#   GATEWAY_PROJECT_YAML   어댑터 경로 (필수)
#   GATEWAY_IGNORE_HOURS=1 시험용 이음매. 창을 무시한다.
#
# 사용
#   . "$(dirname "$0")/contact-window.sh"
#   if within_contact_window; then …

contact_window_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contact_window_policy_guard="${POLICY_GUARD_BIN:-$contact_window_here/../../scripts/policy-guard.mjs}"

contact_window_tz=""
contact_window_days=""
contact_window_start=""
contact_window_end=""
contact_window_default_responder=""

load_contact_window() {
	local yaml="${GATEWAY_PROJECT_YAML:-}"
	if [ -z "$yaml" ] || [ ! -r "$yaml" ]; then
		# 조용히 기본값으로 흐르지 않는다. 시각이 말없이 바뀌면 사람은 밤에 울린
		# 이유를 알 수 없다.
		echo "contact_window_unreadable: ${yaml:-<GATEWAY_PROJECT_YAML 미설정>}" >&2
		return 1
	fi
	# 어댑터는 두 칸 들여쓰기 매핑만 쓴다(ADK 의 yaml-lite 가 보장한다).
	local blk
	blk="$(awk '/^discord:/{d=1;next} d&&/^[^ ]/{d=0} d&&/^  contact_window:/{c=1;next} c&&/^  [^ ]/{c=0} c' "$yaml")"
	contact_window_tz="$(printf '%s' "$blk" | sed -n 's/^ *timezone: *//p' | head -1)"
	contact_window_start="$(printf '%s' "$blk" | sed -n 's/^ *start_hour: *//p' | head -1)"
	contact_window_end="$(printf '%s' "$blk" | sed -n 's/^ *end_hour: *//p' | head -1)"
	contact_window_days="$(printf '%s' "$blk" | sed -n 's/^ *days: *//p' | head -1 \
		| tr -d '[]' | tr -d ' ')"
	contact_window_default_responder="$(awk '/^discord:/{d=1;next} d&&/^[^ ]/{d=0} d' "$yaml" \
		| sed -n 's/^  default_responder_alias: *//p' | head -1)"

	local missing=""
	[ -n "$contact_window_tz" ]    || missing="$missing timezone"
	[ -n "$contact_window_days" ]  || missing="$missing days"
	[ -n "$contact_window_start" ] || missing="$missing start_hour"
	[ -n "$contact_window_end" ]   || missing="$missing end_hour"
	if [ -n "$missing" ]; then
		echo "contact_window_incomplete:$missing ($yaml)" >&2
		return 1
	fi
	# 요일 이름을 번호로. date +%u 는 1=월 … 7=일.
	local out="" d
	for d in $(printf '%s' "$contact_window_days" | tr ',' ' '); do
		case "$d" in
			mon|Mon|MON) out="$out,1" ;; tue|Tue|TUE) out="$out,2" ;;
			wed|Wed|WED) out="$out,3" ;; thu|Thu|THU) out="$out,4" ;;
			fri|Fri|FRI) out="$out,5" ;; sat|Sat|SAT) out="$out,6" ;;
			sun|Sun|SUN) out="$out,7" ;;
			[1-7])       out="$out,$d" ;;
			*)           echo "contact_window_bad_day: $d" >&2; return 1 ;;
		esac
	done
	contact_window_days="${out#,}"
	return 0
}

within_contact_window() {
  if [ "${GATEWAY_IGNORE_HOURS:-0}" = "1" ]; then
    # Bypassing hours is a deterministic test hook, never a production switch.
    [ "${POLICY_GUARD_TEST_CLOCK:-0}" = "1" ] || return 1
    return 0
  fi
	[ -n "$contact_window_days" ] || return 1
	local dow hour
	dow="$(TZ="$contact_window_tz" date +%u)"
	hour="$(TZ="$contact_window_tz" date +%-H)"
	# The shell values above keep the caller's existing interface. The policy
	# The guard is the authority for the independent discord.contact_window
	# schedule; team_policy.work_hours is enforced by mutation operations.
	[ -r "${GATEWAY_PROJECT_YAML:-}" ] || return 1
	command -v node >/dev/null 2>&1 || return 1
	local guard_args=(
		--operation contact-window
		--adapter "$GATEWAY_PROJECT_YAML"
	)
	# Production derives the time from the guard's clock. Supplying day/hour is
	# reserved for the self-test's explicitly marked fake clock.
	if [ "${POLICY_GUARD_TEST_CLOCK:-0}" = "1" ]; then
		guard_args+=(--day "$dow" --hour "$hour")
	fi
	command node "$contact_window_policy_guard" "${guard_args[@]}" >/dev/null 2>&1
}

# 재촉을 지금 보내도 되는가. 창 안에서만 참이다. 긴급 표시로 우회하지 않는다.
# 거짓이면 호출 측은 횟수를 올리지 말고 다음 창까지 미룬다.
nudge_may_send() {
	within_contact_window
}

# 공용 채널에 올리면 안 되는 글인가. 홈 채널은 팀 전원이 본다.
is_shared_channel_noise() {
	printf '%s' "${1:-}" | grep -qiE \
		'카나리아 접수 실패|job control receipt|synthetic_probe|one.sample.slow|감시 정상화|공개 페이지 응답 이상|watchdog_self_test'
}

# 남이 쓴 글을 인용하면 그 안의 호출 문법이 살아난다. 저장된 요약에
# `@everyone` 이 있어도 확인 요청이 채널 전체를 부르지 않게 한다.
neutralize_mentions() {
	local zwsp=$'​'
	printf '%s' "$1" \
		| sed -e "s/@everyone/@${zwsp}everyone/g" \
		      -e "s/@here/@${zwsp}here/g" \
		      -e "s/<@\(&\?[0-9]\+\)>/<@${zwsp}\1>/g"
}
