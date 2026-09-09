# server 프로파일

서버 한 대를 공유하는 팀입니다. 저장소가 그 호스트에 올라가고, 참가자마다 그
위에 자기 홈이 있으며, 배포 계층은 한 사람이 망가뜨리면 모두가 영향을 받는
자리입니다. `onmam-dev`가 이 프로파일의 인스턴스입니다.

## 이 프로파일이 추가하는 계약

공통 계약은 `.agents/context/execution.yaml`에 있고, 이 프로파일은
`profiles/server/context/execution.yaml`을 얹습니다. 얹히는 쪽에는 공유 대상이
있어야만 성립하는 것만 둡니다.

배포 게이트, 산출물과 반영, 통과 판정, 롤백, 임대, 드리프트, 환경 계층,
장애 등급, 상태 검증이 그것입니다. 여기에 서버 위의 참가자 홈을 뜻하는
`workspace.ssh_home_pattern`이 더해집니다.

이 파일들이 본체에서 나뉜 이유는 하나입니다. 배포 대상이 없는 팀에게 배포 계약을
채우게 하면 `null`로 채워지고, `null`로 채워진 계약은 답한 것처럼 보입니다.
나누고 나면 답하지 않은 배포 게이트가 다시 눈에 띕니다.

## 어댑터가 채워야 하는 것

`projects/_template/`을 복사해 시작합니다. `profile: server`가 이미 적혀
있습니다.

필수는 `workspace.ssh_home_pattern`, `workspace.branch_pattern`,
`commands.validate`, `commands.deploy_dev`, `commands.deploy_production`,
그리고 `guards`, `execution`, `tiers` 세 절입니다. `gateway`는 선택입니다.
`local` 절은 이 프로파일에 없으므로 남아 있으면 거절합니다.

`execution` 아래 값이 `null`로 남아 있으면 그 어댑터는 그 대상에 배포할 준비가
안 된 것입니다. 자세한 내용은 [실행 계약 운영 매뉴얼](../../docs/OPERATIONS.ko.md)에
있습니다.

## 저장소 안의 server 전용 부품

`ops/gateway/`, `data-branch/`, `.github/workflows/production-deploy.yml`은 이
프로파일이 쓰는 부품입니다. 기존 인스턴스의 경로를 바꾸지 않으려고 저장소
최상위에 그대로 두었고, 소속은 `profile.yaml`의 `components`가 선언합니다.
local 프로파일 인스턴스는 이들을 가져가지 않습니다.
