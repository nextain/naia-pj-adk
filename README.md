# naia-pj-adk

여러 개발 도구와 작업공간을 사용하는 팀이 하나의 프로젝트 규칙으로
일하도록 돕는 공개 ADK입니다. 이 저장소는 제품 소스가 아니라 프로젝트
어댑터, 검증 가능한 작업 절차, 게이트웨이 운영 부품을 제공합니다.

핵심 원칙은 다음과 같습니다.

- GitHub 이슈가 업무의 정본입니다. 이슈에는 담당자, 완료 조건, 검증과 롤백을 남깁니다.
- 개발은 이슈 브랜치에서 합니다. 병합과 배포 권한은 프로젝트 역할로 결정합니다.
- `projects/<project>/project.yaml`의 `team_policy`가 이슈 권한, 업무시간, 승인,
  미응답 스레드의 담당 규칙을 선언합니다.
- Discord는 이슈 스레드와 작업 전달을 담당합니다. 대화나 도구 접근은 운영 권한을
  만들지 않습니다.
- 토큰, 비밀번호, 개인 ID, 사설 호스트, 고객 자료와 운영 상태는 추적하지 않습니다.
  런타임 등록부는 무시되는 파일에 둡니다.
- 제품 소스 clone은 `projects/` 밖에 둡니다. 두는 자리는 배치 프로파일이 정합니다.
- 메시징은 `naia-messaging` 패키지가 제공하고, 인스턴스는 고정 버전·설정과 호스트의 업무·권한 어댑터를 갖습니다. 공통 엔진을 복제하지 않습니다.

## 배치 프로파일

팀이 서버 한 대를 공유하는지, 각자 자기 기기에서 clone 받아 일하는지에 따라
필요한 것이 다릅니다. 이 저장소는 그 차이를 `profiles/<이름>/` 디렉터리 두 개로
나눕니다. 브랜치가 아니라 디렉터리인 이유는, 브랜치로 나누면 공통 계약을 고쳐도
한쪽에만 들어가고 두 쪽의 차이가 시간이 지날수록 커지기 때문입니다.

`server`는 서버 한 대에 단독으로 올라가는 팀입니다. 참가자마다 그 위에 자기 홈이
있고, 배포 계층은 한 사람이 망가뜨리면 모두가 영향을 받는 자리입니다. 배포
게이트, 산출물과 반영, 롤백, 임대, 드리프트, 환경 계층이 이 프로파일의
계약입니다.

`local`은 각자 자기 기기에 제품 저장소를 clone해 일하는 팀입니다. 공유 호스트도
배포 계층도 없으므로, 일을 넘기는 자리를 저장소에 둡니다. 배정도 수신도 시작도
결과도 전부 커밋입니다. 기기 등록부, 회차 큐, 형제 작업공간 점검, 인계 기록이 이
프로파일의 모듈입니다.

두 프로파일이 함께 지키는 계약은 `.agents/context/`에 남습니다. 사람에게 답을
재촉하는 방식, 확인 요청의 형식, 수신 확인의 정의, AI가 완료를 선언하지 않는다는
규칙은 어디에 배치되든 같습니다.

어댑터는 `project.yaml`에 `profile`을 하나 선언하고, 검증기는 그 프로파일의
요구만 적용합니다. 한쪽의 필드가 다른 쪽에 남아 있으면 거절합니다.
[배치 프로파일](profiles/README.ko.md)에 자세한 내용이 있습니다.

`policy_contract_version: 1`을 선언한 어댑터만 공통 정책 가드에 연결됩니다. `roles`의
`contributors`, `integrators`, `release_owners`는 역할 그룹이며 한 사람이 여러 그룹에
속할 수 있습니다. `team_policy.authorization.issue_work_roles`에 명시된 역할 또는 그룹만
이슈 작업을 위임받고, `contributors`라는 이름만으로 쓰기 권한을 얻지는 않습니다. 기존
어댑터는 소유자가 역할·그룹과 이슈 작업 권한을 채워 명시적으로 마이그레이션해야 합니다.
참가자 등록부는 추적하지 않는 런타임 투영이고, `ops/gateway/dcg.sh`는 등록된 sender ID를
alias·workspace·역할에 연결한 뒤 이슈 담당·업무시간·승인·운영 명령을 검사합니다. 호스트의
Discord/GitHub 인증과 파일 권한은 이 저장소 밖의 trusted-host 경계에서 제공합니다.

## 새 프로젝트 시작

배치 프로파일을 먼저 고릅니다. server면 `projects/_template/`을, local이면
`projects/_template-local/`을 복사해 프로젝트 사실과 역할을 채우고, 변경을 허용하는
`team_policy.work_hours`와 사람에게 연락할 수 있는 `discord.contact_window`를 각각
정합니다. 두 창은 서로 다를 수 있습니다. Discord는 런타임 등록부와 토큰을 준비한
뒤에만 켜며, 새 어댑터는 먼저 비활성 상태로 계약을 검증합니다.

브랜치 방식은 어댑터가 선언한 `integration_branch`를 따릅니다.

- main-only: `default_branch`와 `integration_branch`를 모두 `main`으로 두고 이슈
  브랜치를 `main`에서 만들어 `main`으로 병합합니다.
- 선언형 통합 브랜치: 어댑터에 실제 통합 브랜치 이름을 선언하고 이슈 브랜치를
  그곳에서 만들어 통합합니다. 운영 승격은 승인된 정확한 리비전으로 별도 수행합니다.

자세한 신규 기여·실패 복구·롤백 절차는 [팀 개발 운영 절차](docs/WORKFLOW.ko.md),
디렉터리 규칙은 [작업공간 레이아웃](docs/WORKSPACE.ko.md)을 참고합니다.

## 독립 clone에서 첫 기여

```bash
git clone <공개-저장소-주소> <프로젝트-디렉터리>
cd <프로젝트-디렉터리>
git fetch origin --prune
```

canonical 저장소를 자신의 fork로 만들고 위 clone의 `origin`은 자신의 fork,
`upstream`은 canonical 저장소의 HTTPS 주소로 둡니다. 어댑터의
`integration_branch`에서 이슈 브랜치를 만든 뒤, 이슈에 연결된 검증 명령을
실행합니다. 결과의 표준 출력·표준 오류·종료코드를 보존하고, PR에는 변경 범위와
검증·롤백 방법을 함께 적습니다. 기여자는 운영 배포나 데이터베이스 변경을 하지
않습니다.

첫 미션은 문서 한 파일이나 계약 테스트 한 사례처럼 작고 되돌릴 수 있는 변경으로
선택합니다. 선행 조건은 GitHub 계정과 fork, Node.js 20 이상, 열린 이슈·담당자,
완료 조건, 이슈 브랜치, 실행 가능한 롤백 계획입니다. PR CI가 통과해도 reviewer의
독립 검토, integrator의 병합, release owner의 운영 승인이 끝난 것은 아닙니다.

고위험 변경은 구현자와 독립된 reviewer가 정확한 diff, 실행 명령과 결과, 영향 범위,
동시 변경, 롤백 산출물을 확인합니다. 이 저장소의 production workflow는 push나 PR로
실행되지 않고 `workflow_dispatch`와 명시적인 `production` environment를 요구하는
실패 방지용 guard입니다. 비활성 example adapter에서는 배포 명령이 없어 종료코드
1로 멈춥니다.

게이트웨이의 issue-work는 `submit`, `restart --job <id>`, `amend`로만 연결되며,
`retry`는 native 런타임 명령이 아닙니다. 이슈 작업은 인증된 프로젝트 backend를
명시해야 하고 native 개인 런타임으로 우회하지 않습니다. native `service`와
`cutover prepare|verify|canary|rollback`은 런타임 관리로만 취급하며 production 배포가
아닙니다. production·database·rollback은 어댑터의
`gateway.project_backend.capabilities`에 선언된 backend 명령만 사용하고, 명령 인자에
승인된 `--revision <40자리 SHA>`를 정확히 하나 전달합니다. `POLICY_REVISION`을 함께
쓰면 같은 값인지 확인합니다. `artifacts list`만 native 조회로 허용하며 `artifacts prune`은
변경 명령이라 게이트웨이에서 거부합니다. `attachment --output`은
`PROJECT_POLICY_OPERATION=attachment-download`를 명시한 제한된 다운로드로만 실행합니다.
`contact-window`는 backend를 호출하지 않는 연락 가능 시간 확인입니다.

`service`, `cutover`, `cancel`은 런타임 소유자의 호스트에서 복구하는 로컬 작업입니다.
project backend나 원격 라우터로 자동 전달하지 않으며, 원격 요청은 별도의 인증된 소유자
권한을 통과해야 합니다.

`PROJECT_GATEWAY_WORKSPACE`는 trusted host가 인증된 참가자에게서 투영한 canonical 절대
workspace 경로이며, 등록부의 참가자 workspace와 일치하는 기존 디렉터리일 때만 project
backend에 전달됩니다. issue-work와 high-impact project backend는 이 canonical 경로에서
실행됩니다. 이 값 검사는 호스트 파일시스템 sandbox를 대신하지 않습니다.

## 게이트웨이 capability와 협업 경계

프로젝트 어댑터의 `gateway.project_backend.capabilities`는 명령 이름과 인자 모양을
선언합니다. bridge는 어댑터, 인증된 참가자와 역할, 열린 이슈 증거, route의 프로젝트
ID, canonical workspace를 입력으로 받아 policy를 다시 검사한 뒤 정확한 `argv`, `cwd`,
허용 경로 또는 거부 사유를 반환합니다. 이 결과를 받은 호출자가 임의로 인자를 덧붙이거나
다른 workspace로 바꾸지 않습니다. issue-work의 repository·number·assignee와 restart의
job id는 선언된 placeholder 위치에만 투영하고, production·database·rollback은 승인된
40자리 SHA를 `--revision`으로 한 번만 전달합니다.

참가자 등록부의 mutation window가 열려 있을 때만 역할 변경이나 workspace 연결을
적용합니다. 창이 닫히면 읽기와 진단만 남기고 기존 등록부를 조용히 덮어쓰지 않습니다.
이전 어댑터는 `policy_contract_version`, `issue_work_roles`, work hours와 capability를
명시한 마이그레이션 diff를 먼저 만들고 검증합니다. 예전 필드 이름이나 주변 `tmp`를
자동 복구 입력으로 삼지 않습니다.

업무 분담도 권한과 함께 고정합니다. contributor는 이슈 작업과 검증을 제안하고,
integrator는 독립 검토 뒤 통합하며, release owner는 production·database·rollback
승인과 운영 리비전을 맡습니다. reviewer는 구현자와 분리된 diff·로그·롤백 증거를 확인하고,
원격 라우터는 인증된 요청을 전달할 뿐 로컬 런타임 소유권을 대신하지 않습니다.

## 검증

```bash
npm test
```

`npm test`는 계약·구조·게이트웨이 self-test·공개 안전 검사를 순서대로 실행합니다.
공개 안전 검사는 현재 트리와 도달 가능한 Git 이력을 모두 확인합니다. 공개 전환,
템플릿 배포, push는 소유자의 정확한 후보 SHA 검수 뒤에 별도로 수행합니다.

현재 저장소는 공통 example adapter를 비활성 상태로 제공하므로 예제 검증은 실제
프로젝트 배포를 증명하지 않습니다. 제품별 배포 명령과 런타임 자격은 각 프로젝트가
자체 어댑터와 무시되는 런타임 설정으로 채웁니다.

## 라이선스와 제3자 자료

이 저장소의 원본은 Apache-2.0으로 배포합니다. `NOTICE`의 안내에 따라 downstream이
추가하는 제3자 소스와 상표의 원래 고지와 라이선스를 보존합니다. 이름이나 자료의
권리는 이 저장소의 라이선스로 이전되지 않습니다.

저장소 간 채택 범위와 제외한 개인·운영 자료는 [계보 문서](docs/LINEAGE.ko.md),
상세한 fork·PR·실패·롤백 절차는 [팀 개발 운영 절차](docs/WORKFLOW.ko.md)에서
확인할 수 있습니다.
