# 팀 개발 운영 절차

## 첫 기여

1. GitHub에서 이슈를 만들거나 배정받습니다. 목표, 완료 조건, 검증 명령, 영향
   범위와 롤백 방법을 먼저 적고 담당자를 지정합니다.
2. canonical 저장소를 자신의 fork로 만든 뒤 HTTPS 주소로 clone합니다. upstream은
   canonical 저장소의 HTTPS 주소로 등록하고, 직접 push하지 않습니다.

   ```bash
   git clone https://github.com/<your-account>/<repository>.git
   cd <repository>
   git remote add upstream https://github.com/<canonical-owner>/<repository>.git
   git fetch upstream --prune
   ```

3. 어댑터의 `integration_branch`에서 이슈 브랜치를 만듭니다. `main-only` 프로젝트는
   `default_branch`와 `integration_branch`를 모두 `main`으로 선언합니다. 별도 통합
   흐름을 쓰는 프로젝트는 실제 이름을 어댑터에 선언하며, 문서의 `dev` 같은 고정
   이름을 전제로 하지 않습니다.

   ```bash
   git switch -c issue/123-short-name upstream/<integration-branch>
   ```

4. 이슈와 프로젝트 컨텍스트를 읽고, 그 디렉터리에서 Codex 또는 Claude를 실행합니다.
   첫 미션은 문서 수정이나 계약 테스트처럼 작고 되돌릴 수 있는 변경으로 고릅니다.
   운영 배포·DB 변경은 첫 미션의 범위가 아닙니다.
5. 결과를 직접 확인하고 원시 stdout, stderr, 종료코드를 보존합니다. 커밋 메시지와
   이슈에는 변경 범위, 검증, 확인 방법, 롤백 방법을 기록합니다.

   ```bash
   git status
   npm test
   git add <확인한-파일>
   git commit -m "docs: issue 123 contribution guide"
   git push -u origin issue/123-short-name
   ```

6. 자신의 fork에서 canonical 저장소의 선언된 통합 브랜치로 PR을 엽니다. CI 통과는
   병합이나 운영 배포를 뜻하지 않습니다. 기여자는 PR에서 production이나 공유
   데이터베이스를 직접 변경하지 않습니다.

게이트웨이를 사용하는 프로젝트의 실제 요청 진입점은 `ops/gateway/dcg.sh`입니다.
이 스크립트는 owner-managed 등록부에서 인증된 sender ID를 참가자 alias와 역할에
연결하고, 열린 이슈의 담당자와 어댑터의 `issue_work_roles`를 확인합니다. 이슈 작업,
DB 변경, production 배포는 어댑터의 `team_policy.work_hours` 안에서만 실행되며,
정상적인 호스트 호출은 `POLICY_DAY`나 `POLICY_HOUR`를 주입해 시각을 바꿀 수 없습니다.
실제 Discord/GitHub 인증은 호스트 경계의 책임입니다.

게이트웨이 bridge의 입력은 어댑터 계약, 인증된 참가자와 역할, 열린 이슈 증거, route의
프로젝트 ID, canonical workspace와 호출 단계입니다. 출력은 정책을 통과한 정확한
backend argv와 cwd·허용 경로이며, 어느 값이든 불일치하면 거부 사유만 반환합니다.
참가자 등록부를 바꾸는 작업은 선언된 mutation window 안에서만 수행하고, 창 밖에서는
읽기·진단만 허용합니다. 기존 어댑터는 policy contract, 역할, work hours와 capability를
명시한 마이그레이션을 먼저 검증해야 하며, 임시 파일이나 주변 checkout을 복구 근거로
사용하지 않습니다.

역할은 업무 경계로도 나눕니다. contributor는 issue-work와 검증을 수행하고,
integrator는 독립 검토 뒤 통합하며, release owner는 운영 리비전과 production·database·
rollback 승인 및 실행을 책임집니다. reviewer는 구현자와 분리된 diff·원시 로그·롤백
증거를 확인합니다. service·cutover·cancel은 runtime 소유자의 호스트에서 수행하는
로컬 복구이고, 원격 router가 이를 전달하려면 별도의 인증된 owner permission이 필요합니다.

## 브랜치 흐름

어댑터의 선언이 실제 제품 저장소의 기준입니다.

| 모드 | 이슈 브랜치의 시작점 | PR 대상 | 운영 승격 |
| --- | --- | --- | --- |
| main-only | `main` | `main` | 별도 승인된 리비전 |
| declared integration | 선언된 `integration_branch` | 같은 통합 브랜치 | 별도 승인된 리비전 |

통합 브랜치와 운영 리비전은 같은 이름이나 관례로 추정하지 않습니다. 병합에는
integrator가 필요하고, 고위험 변경에는 구현자와 독립된 reviewer가 필요합니다.
reviewer는 정확한 diff, 실행 명령과 결과, 영향 범위, 동시 변경, 롤백 산출물을
확인한 뒤 결과를 이슈에 남깁니다.

## 이슈에 남길 통합 요청 예시

> 이슈 #123을 완료했습니다. 이슈 브랜치의 커밋 `<SHA>`입니다. `<검증 명령>`을
> 실행해 통과했고, `<확인 절차>`와 `<되돌리기 절차>`를 준비했습니다. 선언된
> 통합 브랜치로 검토와 병합을 요청합니다.

## 통합 담당자

1. 이슈의 완료 조건과 검증 결과, 원시 증거, 롤백 산출물을 확인합니다.
2. 구현자와 독립된 reviewer의 결과를 확인한 뒤 선언된 통합 브랜치에 병합합니다.
3. 개발 계층을 실제로 사용하는 어댑터라면 환경 주소, 병합 SHA, 확인 결과를 같은
   이슈에 기록합니다. 비활성 예제의 `null` 명령은 배포 증거가 아닙니다.
4. 실패하면 병합 전 리비전으로 되돌리고, 같은 이슈를 다시 작업 상태로 돌립니다.

## 운영 승격

production 워크플로는 push나 PR을 트리거로 사용하지 않습니다. 이 저장소가 제공하는
워크플로는 `workflow_dispatch`와 명시적인 `production` environment를 가진 실패
방지용 guard이며, 비활성 예제에서는 배포 명령이 없어 종료코드 1로 멈춥니다.

실제 프로젝트는 release owner가 이슈에 정확한 리비전, 승인, 실행자, 검증 결과와
롤백 참조를 남긴 뒤 수동 실행합니다. GitHub 환경 보호 규칙이나 승인 설정이 이미
있다고 가정하지 말고, 저장소와 프로젝트의 실제 설정을 함께 확인합니다. 장애가
진행 중이면 승인 대기보다 materialized rollback을 먼저 실행하고 사후 증거를 남깁니다.

production gateway 요청은 어댑터의
`gateway.project_backend.capabilities.production_deploy`에 선언된 project 명령으로만
실행하며, 그 명령에 `--revision <40자리 SHA>`를 정확히 하나 포함해야 합니다. native
`cutover prepare|verify|canary|rollback`은 런타임 관리 명령이고 production 배포로
간주하지 않습니다. guard가 검사한 값과 backend가 받은 명령의 값이 달라질 수 없도록
`POLICY_REVISION`을 함께 설정하면 같은 값인지 확인합니다. database 변경과 rollback도
각각 선언된 project backend capability가 없으면 거부합니다. `contact-window`는 사람에게
재촉할 수 있는지 확인할 뿐 backend나 Discord를 활성화하지 않습니다.

## 금지 사항

- 이슈 없이 작업·병합·배포하지 않습니다.
- canonical 저장소에 직접 push하지 않습니다.
- 이슈 브랜치에서 production이나 공유 데이터베이스를 직접 변경하지 않습니다.
- Discord, AI 도구 접근, CI 통과만으로 권한이나 승인을 추정하지 않습니다.
- 비밀번호, 토큰, 개인 ID, 사설 서버 주소, 고객 자료, 운영 상태를 이슈나 저장소에
  적지 않습니다.
