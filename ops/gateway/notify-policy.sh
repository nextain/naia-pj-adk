#!/bin/bash
# 사람에게 알릴지, 어디로, 지금인지.
#
# 승인을 재는 축(사용자 영향·시스템 위험·트래픽)과 알림을 재는 축은 다르다.
# 승인은 일을 해도 되는지다. 알림은 사람을 깨워도 되는지다.
#
# 실증에서 한 사이트가 한 번 임계를 넘긴 뒤 다음 샘플에서 통과하자
# 공용 채널에 「이상」과 「정상화」가 연속으로 올랐다. 팀은 장애가 난 줄
# 알았고, 실제 고장은 없었다. 카나리·침묵 프로브도 「워치독 고장」으로
# 분류되어 근무시간 창을 우회해 담당자 DM 을 채웠다.
#
# 사용
#   . ops/gateway/contact-window.sh
#   . ops/gateway/notify-policy.sh
#   load_contact_window || exit 2
#   kind=one_sample_slow
#   if notice_may_send shared_channel "$kind"; then send; fi
#   flap_should_alert fail pass 1 0   # → none
#
# 의존: contact-window.sh 의 within_contact_window. 창을 안 읽었으면
# 근무시간 판정은 닫힌 것으로 본다. 열어 두면 야간에 흐른다.

# 한 샘플 실패 뒤에 바로 통과해도 장애 알림을 내지 않는 연속 실패 횟수.
NOTIFY_FAIL_STREAK="${NOTIFY_FAIL_STREAK:-2}"

# 알림 종류 → 긴급도. 세 값만 쓴다.
#   silent     보내지 않는다
#   window     근무시간에만, 공용 채널이 아니면
#   immediate  창과 무관. 실제 사용자 장애·실제 게이트웨이 수신 사망만
classify_notice() {
	case "${1:-}" in
		one_sample_slow|recovery_of_one_sample|synthetic_probe|canary|watchdog_self_test|bot_silence|flap_recovery)
			printf 'silent\n' ;;
		thread_nudge|routine_reminder|helper_unit_failure|probe_false_positive)
			printf 'window\n' ;;
		persisted_user_visible|gateway_ws_dead|delivery_failure)
			printf 'immediate\n' ;;
		*)
			# 모르는 종류를 immediate 로 열면 창이 빈다. 창으로 보낸다.
			printf 'window\n' ;;
	esac
}

# 공용 홈 채널에 올리면 전원이 본다. silent 종류와 단발 복구는 여기 금지.
shared_channel_forbidden() {
	case "${1:-}" in
		one_sample_slow|recovery_of_one_sample|synthetic_probe|canary|watchdog_self_test|bot_silence|flap_recovery|probe_false_positive|helper_unit_failure)
			return 0 ;;
		*)
			return 1 ;;
	esac
}

# 담당자 DM 은 수신함이 아니다. 실제 게이트웨이 사망과 전달 실패만.
owner_dm_allowed() {
	case "${1:-}" in
		gateway_ws_dead|delivery_failure)
			return 0 ;;
		*)
			return 1 ;;
	esac
}

_notice_in_window() {
	if type within_contact_window >/dev/null 2>&1; then
		within_contact_window
	else
		return 1
	fi
}

# notice_may_send DEST KIND
# DEST: shared_channel | thread | owner_dm
# 0 = 지금 보내도 됨. 1 = 보내지 말 것 (횟수도 세지 말 것).
notice_may_send() {
	local dest="${1:-}" kind="${2:-}" urgency
	urgency="$(classify_notice "$kind")"
	[ "$urgency" != "silent" ] || return 1
	case "$dest" in
		shared_channel)
			shared_channel_forbidden "$kind" && return 1
			# 공용 채널은 즉시 사용자 장애여도 장문을 올리지 않는다.
			# 스레드가 있다. 한 줄 현황만 창 안에서.
			_notice_in_window || return 1
			return 0
			;;
		owner_dm)
			owner_dm_allowed "$kind" || return 1
			# 실제 게이트웨이 사망은 창과 무관. 그 밖은 여기 오지 않는다.
			return 0
			;;
		thread)
			[ "$urgency" = "immediate" ] && return 0
			_notice_in_window || return 1
			return 0
			;;
		*)
			return 1
			;;
	esac
}

# flap_should_alert PREV CURR STREAK ALERTED
# PREV/CURR: pass | fail
# STREAK: 지금 연속 실패 횟수 (CURR=fail 일 때 의미)
# ALERTED: 이번 실패 구간에 장애 알림을 이미 냈으면 1
# 출력: none | incident | recovery
#
# 단발 실패는 incident 가 아니다. 단발 뒤 통과의 정상화도 아니다.
# 복구 알림은 장애 알림을 실제로 낸 뒤에만.
flap_should_alert() {
	local prev="${1:-pass}" curr="${2:-pass}" streak="${3:-0}" alerted="${4:-0}"
	if [ "$curr" = "fail" ]; then
		if [ "$streak" -ge "$NOTIFY_FAIL_STREAK" ] && { [ "$prev" != "fail" ] || [ "$streak" -eq "$NOTIFY_FAIL_STREAK" ]; }; then
			printf 'incident\n'
			return 0
		fi
		printf 'none\n'
		return 0
	fi
	if [ "$prev" = "fail" ] && [ "$alerted" = "1" ]; then
		printf 'recovery\n'
		return 0
	fi
	printf 'none\n'
}

# 발송 원장 한 줄. 프로세스·목적지·종류·긴급도·결과를 남긴다.
# 경로가 비면 건너뛴다. 토큰·본문은 적지 않는다.
notify_ledger_append() {
	local path="${NOTIFY_LEDGER:-}"
	[ -n "$path" ] || return 0
	local dest="${1:-}" kind="${2:-}" urgency="${3:-}" result="${4:-}" process="${5:-}"
	mkdir -p "$(dirname "$path")" 2>/dev/null || return 0
	printf '%s dest=%s kind=%s urgency=%s result=%s process=%s\n' \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$dest" "$kind" "$urgency" "$result" "$process" >> "$path"
}
