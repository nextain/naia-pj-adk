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
	[ "${GATEWAY_IGNORE_HOURS:-0}" = "1" ] && return 0
	[ -n "$contact_window_days" ] || return 1
	local dow hour
	dow="$(TZ="$contact_window_tz" date +%u)"
	hour="$(TZ="$contact_window_tz" date +%-H)"
	case ",$contact_window_days," in *",$dow,"*) ;; *) return 1 ;; esac
	[ "$hour" -ge "$contact_window_start" ] && [ "$hour" -lt "$contact_window_end" ]
}

# 남이 쓴 글을 인용하면 그 안의 호출 문법이 살아난다. 실증 프로젝트의 저장된 요약
# 하나에 `@everyone` 이 있었고, 그대로 실렸다면 확인 요청 한 통이 서버 전체를
# 부를 뻔했다. 보이는 모양은 두고 호출만 성립하지 않게 한다.
neutralize_mentions() {
	local zwsp=$'​'
	printf '%s' "$1" \
		| sed -e "s/@everyone/@${zwsp}everyone/g" \
		      -e "s/@here/@${zwsp}here/g" \
		      -e "s/<@\(&\?[0-9]\+\)>/<@${zwsp}\1>/g"
}
