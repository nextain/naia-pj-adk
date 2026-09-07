# 게이트웨이 감시 부품

프로젝트 봇이 사람에게 확인을 요청할 때 쓰는 공통 부품입니다. 운영 사실(호스트,
채널, 개인 식별자)은 여기에 없습니다. 시각과 담당은 어댑터에서, 식별자는 추적하지
않는 런타임 등록부에서 옵니다.

## 왜 있나

첫 실증 프로젝트의 감시 자동화가 이틀 동안 한 번도 동작하지 않았는데 아무도
알지 못했습니다. 원인은 하나가 아니라 같은 모양의 여러 개였습니다.

- 예약 실행 환경의 탐색 경로가 달라 도구가 시작하자마자 죽었습니다. 손으로
  돌리면 통과하므로 만들 때의 검증도 통과했습니다.
- 상태 조회의 오류를 버려 "없음"과 "모름"이 같아졌고, 하나만 처리해야 할 자리에서
  가드가 열린 채 통과할 수 있었습니다.
- 확인 요청이 아무도 지명하지 않아, 여섯 건이 재촉 한도를 다 쓰도록 아무에게도
  알림이 울리지 않았습니다.
- 저장된 요약 하나에 `@everyone` 이 있었습니다. 그대로 실렸다면 확인 요청 한
  통이 서버 전체를 부를 뻔했습니다.

전부 "있다"와 "동작한다"를 구분하지 못해 생긴 일입니다.

## 파일

| 파일 | 역할 |
|---|---|
| `gateway-env.sh` | 실행 환경 고정과 런타임 최소 버전 관문. 어긋나면 `exit 2`. `gw_query` 로 조회 실패를 fail-closed 로 만듭니다. |
| `contact-window.sh` | 어댑터의 `discord.contact_window` 를 읽어 지금 물어도 되는지 판정하고, 인용문의 호출을 무력화합니다. |
| `notify-policy.sh` | 알림 종류를 silent/window/immediate 로 재고, 공용 채널·담당자 DM·스레드에 지금 보낼지와 단발 실패의 펄럭임을 막습니다. 발송 원장 한 줄을 남깁니다. |
| `audit.sh` · `audit-report.py` | 추적표·이슈·스레드·바인딩 네 표면을 대조합니다. 고치지 않고 어긋난 곳만 말합니다. |
| `alert-unit-failed.sh` | 감시 유닛이 죽었다는 사실 자체를 알립니다. 발송 실패를 삼키지 않습니다. |
| `systemd/unit-failed@.service` · `systemd/onfailure.conf` | 어느 감시 유닛이 죽어도 그 알림이 돌게 붙이는 조각입니다. |
| `gateway.config.sample.json` | 런타임 설정의 모양. 실제 값은 추적하지 않는 경로에 둡니다. |
| `selftest.sh` | 위 부품들이 **막혀야 할 때 막는지** 확인합니다. 네트워크를 쓰지 않습니다. |

추적표의 모양은 `schemas/followups.schema.json` 에 있습니다. 개인 식별자는 두지
않고, 실행 중 갱신되므로 추적하지 않는 경로에 둡니다.

## 쓰는 법

```sh
export GATEWAY_RUNTIME_BIN=/path/to/runtime/bin   # 예약 실행 환경의 경로 고정
export GATEWAY_PROJECT_YAML=projects/<project>/project.yaml
. ops/gateway/gateway-env.sh
. ops/gateway/contact-window.sh
load_contact_window || exit 2

if within_contact_window; then
  send_re_ask "$(neutralize_mentions "$quoted_summary")"
fi
```

`nudge_may_send` / `within_contact_window` 가 거짓이면 **횟수를 세지 말고** 넘깁니다. 세어 버리면
아무도 못 본 사이에 재촉 한도를 다 씁니다. 재촉은 긴급 표시로 창을 열지 않습니다.

알림은 `classify_notice` 로 먼저 급을 잽니다. `notice_may_send dest kind` 가 거짓이면
보내지 않습니다. 프로브·카나리·한 샘플 느림·그 정상화·봇 침묵은 silent 입니다.
「워치독 고장」으로 창을 우회하지 않습니다. 창과 무관한 것은 연속된 사용자 장애,
게이트웨이 웹소켓 사망, 실제 전달 실패뿐입니다. `flap_should_alert` 는 연속 실패가
임계에 이르기 전에도, 그 단발 뒤 통과의 정상화도 보내지 않습니다. 복구 알림은
장애 알림을 실제로 낸 뒤에만입니다.

`is_shared_channel_noise` 가 참인 글은 홈 채널에 올리지 않고 답하지도 않습니다.
토큰을 쓰는 모든 프로세스가 이 판정을 거칩니다. 게이트웨이만 거치고 바깥 감시가
우회하면 한 봇 얼굴로 창이 빈 알림이 올라갑니다.

## 확인

```sh
npm run gateway:selftest
```

게이트를 고친 뒤에는 한 번 일부러 깨뜨려 시험이 잡는지 보십시오. 통과만 확인한
게이트는 통과만 하는 게이트일 수 있습니다.

## 프로젝트 CLI 경계

`ops/gateway/dcg.sh` 는 신뢰된 호스트에서 프로젝트 어댑터와 로컬 런타임 사이를
검사하는 진입점입니다. 이 검사는 Discord/GitHub 발신자 인증, 파일 권한, 샌드박스
또는 원격 메시지 라우터를 대신하지 않습니다. 호스트가 제공하는 발신자와 작업공간
투영을 검증한 뒤, 실제 위임 전에 정책을 다시 평가합니다.

다음 환경 변수는 값 자체를 저장하지 않는 실행 계약입니다.

| 변수 | 용도 |
|---|---|
| `GATEWAY_PROJECT_YAML` | 읽을 수 있는 프로젝트 어댑터 |
| `GATEWAY_PARTICIPANT_REGISTRY` | 로컬 참가자 등록부 |
| `POLICY_SENDER_ID` · `POLICY_ACTOR_ALIAS` | 호스트가 인증한 참가자 투영 |
| `POLICY_ISSUE_EVIDENCE` | 실제 이슈의 저장된 증거 |
| `PROJECT_GATEWAY_WORKSPACE` | 참가자와 일치해야 하는 절대 작업공간 |
| `PROJECT_POLICY_OPERATION` | `issue-work`, `production-deploy`, `database-write`, `rollback`, `attachment-download` 같은 명시 작업 |
| `NAIA_DCG_BACKEND` | `project`, `adk`, `auto` 중 위임 대상 |
| `PROJECT_GATEWAY_CTL` · `NAIA_ADK_ROOT` | 프로젝트 컨트롤러와 실제 naia-adk 런타임 경로 |
| `POLICY_GUARD_TEST_CLOCK` · `POLICY_DAY` · `POLICY_HOUR` | 폐기 가능한 테스트 시계 전용 입력 |

native 명령의 허용 범위는 버전이 붙은
[`native-command-contract.json`](native-command-contract.json)에 있습니다. 상태 조회와
`artifacts list`만 읽기 작업입니다. `artifacts prune`은 노출하지 않으며, `retry`는
지원하지 않고 `restart --job <id>`를 사용합니다. native `service`, `cutover`, `cancel`은
소유자가 있는 호스트에서만 수행하는 로컬 복구 작업으로 project production backend와
분리됩니다. 원격 라우터가 이 작업을 전달하려면 별도의 인증된 소유자 권한을 확보해야
하며, 게이트웨이는 project backend로 전달하지 않습니다. native cutover에는
`--revision`을 넘기지 않습니다.

이슈 작업은 명시적인 `NAIA_DCG_BACKEND=project`와 실행 가능한
`PROJECT_GATEWAY_CTL`, 열린 이슈 증거, 등록부의 참가자·역할·정식 작업공간이 모두
있어야 합니다. `submit`, `restart --job <id>`, `amend`만 프로젝트 capability에
선언할 수 있고, 증거의 저장소·번호·담당자가 위임 argv에 함께 바인딩됩니다.
production·database·rollback은 프로젝트 capability와 정확히 하나의 별도 40자리
revision을 요구합니다. 승인된 revision과 backend에 전달하는 revision이 다르면
거부합니다.

attachment는 `attachment-download`를 명시해야 하며, `--output`은 참가자 작업공간
안의 아직 없는 절대 경로여야 합니다. 심볼릭 링크를 따라간 실제 경로도 작업공간
경계 밖이면 거부합니다. 등록부가 손상된 경우에도 trusted host의 상태 조회와
서비스 복구는 가능하지만, 원격 참가자의 mutation 권한을 부여하지는 않습니다.

예제의 실행은 실제 Discord 활성화가 아닙니다. 비밀값은 저장소에 넣지 말고, native
helper가 바뀌면 위 contract와 wrapper 회귀시험을 함께 갱신하십시오.

### native 구현 일치 검사

`native-command-contract.json`은 프로젝트 wrapper가 노출하는 경계이고, 실제
`naia-adk` CLI의 인자·옵션·관리 작업 목록은 native 구현이 소유합니다. native
dispatch는 `NAIA_ADK_ROOT`에 명시된 절대 경로를 받아야 하며, 인접한 checkout을
자동으로 찾지 않습니다. dispatch 직전에 validator가 contract의
`native_dependency` module/export를 그 경로에서 읽어 surface, 옵션, service/cutover
작업을 비교하고, 불일치하면 native 프로세스를 시작하지 않습니다.

예를 들어 wrapper contract와 특정 native checkout을 함께 검사합니다.

```bash
node scripts/native-command-validator.mjs \
  --contract ops/gateway/native-command-contract.json \
  --native-root /absolute/path/to/naia-adk \
  -- status
```

전체 경계 회귀시험은 다음처럼 실행합니다. `NAIA_NATIVE_ROOT`를 절대 경로로 설정한
경우에만 native 구현 일치 검사를 활성화합니다. 설정하지 않으면 그 통합 사례는
건너뛰며, 인접한 `tmp`나 다른 checkout을 자동으로 찾지 않습니다.

```bash
node --test scripts/native-command-validator.test.mjs scripts/policy-guard.test.mjs
NAIA_NATIVE_ROOT=/absolute/path/to/naia-adk \
  node --test scripts/native-command-validator.test.mjs
```

## 바깥층 감시

여기 있는 것은 전부 감시 대상과 같은 장비에서 돕니다. 그 장비가 죽으면 함께
죽습니다. 그래서 장비 밖에도 한 겹이 필요합니다. 클라우드 관제면에 세 가지를
둡니다.

1. 장비가 내려간 경우
2. 장비는 켜져 있으나 운영체제나 수집 에이전트가 멈춘 경우
3. **장비도 서비스도 멀쩡한데 예약 작업만 돌지 않는 경우**

셋 중 마지막이 실제로 겪은 형태입니다. 앞의 둘만 두면 "살아 있으면서 일을 안
하는" 상태를 놓칩니다.

부재를 알림으로 바꾸려면 요령이 하나 필요합니다. 로그 기반 알림은 대개 질의가
행을 돌려줘야 발동하는데, 신호가 끊기면 행이 없습니다. "없음"을 그대로 조건에
걸면 영원히 조용합니다. 집계 함수가 빈 입력에도 한 행을 돌려주는 성질을 써서
뒤집습니다.

```
<로그원본> | where <프로세스> startswith '<감시 접두사>'
           | summarize Runs = count()
           | where Runs == 0
```

건강하면 0행이라 조용하고, 끊기면 1행이라 발동합니다. 조건은 "행이 하나라도
있으면"으로 겁니다.

## 아직 여기 없는 것

후속 감시기 본체, 배분기, 우리 차례 판정기는 게이트웨이 도구의 호출 규약과
추적표 생명주기에 함께 묶여 있어 실증 프로젝트 쪽에만 있습니다. 그 규약을
`ops/gateway/` 안의 얇은 어댑터로 분리한 뒤에 옮깁니다.
