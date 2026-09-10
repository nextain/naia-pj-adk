# local 프로파일

각자 자기 기기에 제품 저장소를 clone해 일하는 팀입니다. 공유 호스트도, 서버 위의
홈 디렉터리도, 배포 계층도 없습니다. `naia-comm`이 이 프로파일의 첫
인스턴스입니다.

## 무엇이 문제였나

일을 넘길 서버가 없으면 넘기는 자리는 대화가 됩니다. 그런데 대화는 넘겼다는
사실만 남기고 상대가 시작했는지는 남기지 않습니다. 게시 성공은 수신이 아니고
수신은 시작이 아닙니다. 세 사건을 하나로 취급하면 아무도 돌리지 않은 일이
진행 중으로 기록됩니다.

그래서 이 프로파일은 큐를 저장소에 둡니다. 배정도 수신도 시작도 결과도 전부
커밋입니다. 기기가 pull하고, 자기가 돌릴 수 있는 묶음을 가져가고, PID를 담은 시작
영수증을 쓰고, 실행하고, 케이스마다 판정 하나를 담은 종료 영수증을 쓰고
push합니다.

## 구성 요소

**기기 등록부 `devices/`.** 파일 하나가 기기 하나이고 파일 이름이 기기 ID입니다.
회차 레인 하나가 기기 하나이므로, 등록되지 않은 기기의 claim은 아무도 찾을 수
없는 실행자를 가리킵니다. 필수 항목은 `id`, `platform`, `owner`입니다.

**회차 집행기 `scripts/qa-round.mjs`.** `open`, `claim`, `start`, `finish`,
`ledger`, `status`, `close`, `validate`를 제공합니다. 회차를 열 때 카탈로그를
해시로 고정하므로 이후의 수정은 거부됩니다. claim은 만료되고, 만료된 claim은
누구나 다시 가져갑니다. 원장은 영수증에서만 도출하며 손으로 고치지 않습니다.
계약 원문은 `context/qa-rounds.yaml`입니다.

**형제 배치 점검 `scripts/workspace.mjs`.** 제품 저장소를 허브의 형제
(`../<id>`)에 독립 clone으로 두었는지 봅니다. 허브가 허브인 이유는 다른 저장소
목록을 알기 때문이지 그것들을 밑에 두었기 때문이 아닙니다. `plan`은 빠진 형제의
clone 명령을 출력하고 아무것도 바꾸지 않습니다. `doctor`는 각 형제가 있는지,
독립 Git 루트인지, 원격이 맞는지, 깨끗한 커밋 위에 있는지를 보고 어긋나면 0이
아닌 코드로 끝납니다.

**저장소 목록 `workspace/repos.json`.** 버전 고정이 아니라 목록입니다. 회차
후보의 정확한 SHA 조합은 `qa/rounds/<회차>/round.json`에 있습니다.

**인계 기록 `handoffs/`.** 상태, 남은 일, 실제 경로와 SHA, 다음 소유자를 적습니다.
"로컬"이라는 상대어를 쓰지 않습니다.

## 인스턴스가 채택하는 방법

1. `projects/_template-local/`을 자기 저장소의 `projects/<이름>/`으로 복사하고
   프로젝트 사실과 역할을 채웁니다. `profile: local`이 이미 적혀 있습니다.
2. `profiles/local/context/qa-rounds.yaml`을 `.agents/context/qa-rounds.yaml`로
   복사합니다. 계약은 인스턴스가 소유해야 하므로 참조가 아니라 복사입니다.
3. `profiles/local/scripts/`의 두 파일과 `qa-round.test.mjs`를 자기 저장소의
   `scripts/`로 복사하고, `npm test`에 `node scripts/qa-round.test.mjs`를
   넣습니다. 두 파일은 자리를 세지 않고 Git 저장소 루트를 찾아 올라가므로
   `scripts/`에 두든 `profiles/local/scripts/`에 두든 그대로 동작합니다.
   `QA_ROUND_ROOT`와 `NAIA_WORKSPACE_ROOT`로 루트를 직접 지정할 수도 있습니다.
4. `profiles/local/devices/README.ko.md`를 `devices/`로 복사하고 실제 기기 파일을
   추가합니다. 예시 파일은 지웁니다.
5. `profiles/local/workspace/repos.json`을 `workspace/repos.json`으로 복사하고
   `owner`, `hub`, `repositories`를 자기 것으로 바꿉니다. 경로는 모두 `../<id>`
   형태를 유지합니다.
6. `handoffs/README.ko.md`를 복사합니다.

복사이지 심볼릭 링크가 아닙니다. 인스턴스는 자기 계약의 소유자여야 하고, 상위
저장소의 파일이 조용히 바뀌어 인스턴스의 판정이 달라지는 일이 없어야 합니다.
검증된 개선은 인스턴스에서 이 프로파일로 올려 보냅니다.

## 어댑터가 채워야 하는 것

필수는 `workspace.branch_pattern`, `commands.validate`, `local_workspace.devices_dir`
입니다. `local_workspace` 아래의 `qa_rounds_dir`, `handoffs_dir`, `workspace_catalog`,
`guards`, `gateway`는 선택입니다.

`workspace.ssh_home_pattern`, `tiers`, `execution`, `commands.deploy_dev`,
`commands.deploy_production`은 이 프로파일에 없습니다. 남아 있으면 거절합니다.
server 어댑터를 복사해 오면서 지우지 않은 것이고, 그대로 두면 아무도 갖고 있지
않은 서버 경로와 아무 데도 가지 않는 배포 명령을 가리키게 됩니다.

## 메시징

Discord 설정은 어댑터의 `discord` 절에만 둡니다. 게이트웨이 코드와 감시기
스크립트는 인스턴스가 들고 있지 않습니다. `.agents/context/messaging.yaml`을
참고합니다.
