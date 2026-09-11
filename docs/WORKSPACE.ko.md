# 작업공간 레이아웃

이 ADK는 제품 소스가 아니라 팀 규칙과 프로젝트 어댑터를 저장합니다. 제품 소스와
어댑터를 한 디렉터리에 섞지 않습니다.

```text
<adk-root>/                         ← 이 저장소
├── README.md                       ← 사람용 입구
├── AGENTS.md / CLAUDE.md / GEMINI.md
├── docs/
├── .agents/context/                ← 배치와 무관한 공통 계약
├── profiles/                       ← 배치 프로파일
│   ├── server/                     ← 서버 공유 팀
│   └── local/                      ← 각자 clone 하는 팀
├── data-branch/<git-브랜치>/       ← 브랜치 전용 에이전트 컨텍스트 (server)
├── projects/                       ← 추적되는 프로젝트 어댑터만
│   ├── _template/                  ← server 프로파일 서식
│   ├── _template-local/            ← local 프로파일 서식
│   └── <project>/
├── checkouts/                      ← 제품 clone. 이 저장소에 올리지 않음 (server)
└── ops/gateway/                    ← 게이트웨이 부품 (server)
```

`projects/`에는 제품 저장소를 clone하지 않습니다. server 프로파일에서는 소스를
`checkouts/<repository>/`에 두고, 어댑터에는 프로젝트 사실·권한·검증 계약만
둡니다. local 프로파일에서는 제품 저장소가 이 저장소의 형제(`../<id>`)에 독립
clone으로 놓입니다. 어느 쪽이든 runtime 등록부와 자격 정보는 무시되는 경로에만
둡니다.

## 배치 프로파일

팀이 서버 한 대를 공유하는지, 각자 자기 기기에서 일하는지에 따라 필요한 것이
달라집니다. 그 차이를 브랜치로 나누면 공통 계약을 고쳐도 한쪽에만 들어가므로,
`main` 안의 디렉터리로 나눕니다.

| | server | local |
|--|--------|-------|
| 배치 | 서버 한 대에 단독 | 개인 ADK의 `projects/` 아래 |
| 작업 자리 | 서버 위 참가자 홈 | 각자 기기의 clone |
| 제품 소스 | `checkouts/<repository>/` | 형제 디렉터리 `../<id>` |
| 배포 | 계층과 배포 명령을 선언 | 없음 |
| 일 전달 | 게이트웨이와 이슈 스레드 | 저장소에 있는 회차 큐 |
| 인스턴스 | onmam-dev | naia-comm |

어댑터는 `projects/<프로젝트>/project.yaml`에 `profile`을 하나 선언하고,
검증기는 그 프로파일의 요구만 적용합니다. server 어댑터는
`workspace.ssh_home_pattern`, `tiers`, 배포 명령을 채웁니다. local 어댑터는 그
셋을 갖지 않고 `local_workspace.devices_dir`로 기기 등록부를 가리킵니다. 한쪽의
필드가 다른 쪽에 남아 있으면 검증기가 거절합니다. 남겨 두면 아무도 갖고 있지
않은 서버 경로나 아무 데도 가지 않는 배포 명령을 가리키게 되기 때문입니다.

프로파일마다 `profile.yaml`이 필수·선택·금지 필드를 적고,
`scripts/validate.mjs`가 그 목록을 `scripts/lib/adapter-contract.mjs`의 규칙과
대조합니다. 사람이 읽는 목록과 기계가 적용하는 규칙이 갈라지면 문서 쪽이 조용히
틀린 채로 남기 때문입니다.

자세한 내용은 [배치 프로파일](../profiles/README.ko.md),
[server](../profiles/server/README.ko.md), [local](../profiles/local/README.ko.md)에
있습니다.

## 브랜치

| | 이 ADK 저장소 | 제품 저장소 |
|--|---------------|-------------|
| 통합 브랜치 | `main` | 어댑터의 `integration_branch` |
| 개인 작업 | `issue/<번호>-설명` | 같은 패턴의 이슈 브랜치 |

제품의 통합 브랜치 이름은 `dev`처럼 추정하지 않습니다. `main-only` 모드에서는
`default_branch`와 `integration_branch`가 모두 `main`입니다. 선언형 통합 모드에서는
어댑터가 명시한 브랜치를 사용합니다. 어느 모드에서도 ADK의 `main` 변경만으로
제품 환경이 바뀌지 않습니다.

개인 fork에서 HTTPS로 clone하고 이슈 브랜치를 push한 뒤 canonical 저장소로 PR을
엽니다. upstream에 직접 push하지 않습니다.

## 브랜치별 컨텍스트

server 프로파일에서 씁니다. 공통 `AGENTS.md`를 읽은 뒤
`data-branch/<현재-브랜치>/AGENTS.md`가 있으면 얹습니다.
브랜치 이름의 `/`는 폴더입니다. 같은 폴더의 `AGENTS.md`와 `CLAUDE.md`는 같아야
하며, 없으면 `data-branch/_template/`만 봅니다.

## 이슈별 격리 작업공간

작업자는 이슈마다 전용 워크트리에서 코드를 고칩니다. 위치는 **수신자 체크아웃 바깥**이며
브랜치는 그 이슈의 브랜치(`issue-<n>/<에이전트>`)를 잇습니다. 같은 체크아웃 안의 하위
폴더는 격리가 아닙니다. HEAD와 인덱스를 그대로 공유하기 때문입니다.

수신자 체크아웃은 하네스가 실행되는 곳이라 작업자가 바꾸지 않습니다. 한 작업이 공유
HEAD를 바꾸면 다음 수신이 바뀐 코드로 돌고, 다른 작업은 조용히 깨집니다.

작업공간이 갈리면 동시 실행 슬롯을 2개 이상 둘 수 있습니다. **같은 이슈는 동시에 돌지
않습니다.** 배포·공유 DB·운영 같은 공유 자원 변경은 워크트리와 무관하게 잠금으로
직렬화합니다. 정리는 이슈가 닫힌 뒤이고, 작업물이 남은(dirty) 워크트리는 지우지 않으며
브랜치도 지우지 않습니다. 계약은 `.agents/context/execution.yaml`의 `execution_isolation`입니다.

## 게이트웨이

server 프로파일의 부품입니다. 프로젝트 게이트웨이가 있으면 `ops/gateway/dcg.sh`가 그 CLI로 보냅니다.
`NAIA_DCG_BACKEND=auto`는 실행 가능한 project controller가 실제로 살아 있을 때만
project backend를 선택하고, 그렇지 않으면 명시적으로 설정된 `NAIA_ADK_ROOT`의 adk
backend를 선택합니다. `launch`, `service`, `cutover`, `cancel` 같은 고위험·소유자
로컬 작업은 auto가 권한을 만들어 주지 않습니다. 토큰 소유 게이트웨이는 프로젝트마다 하나이며, 이 저장소에는 토큰이나
개인 참가자 ID를 넣지 않습니다.

`dcg.sh`는 먼저 `scripts/policy-guard.mjs`를 실행합니다. owner-managed 런타임 등록부의
`sender ID → alias → workspace/roles` 투영을 확인하고, 어댑터가 선언한
`team_policy.authorization.issue_work_roles`, 열린 이슈의 담당자, `work_hours`,
production 승인과 리비전을 검사한 뒤에만 프로젝트 CLI 또는 선택된 `naia-adk` 런타임으로
넘깁니다. 등록부와 이슈 증거는 호스트가 인증해 만든 입력이라는 trusted-host 경계를
전제로 하며, 이 검사는 Discord/GitHub 로그인이나 파일 권한을 대신하지 않습니다.

정책 작업은 실제 명령에 묶입니다. `submit`, `restart --job <id>`, `amend`만
issue-work이며, native `retry`는 지원하지 않습니다. issue-work는 명시적인 project
backend가 필요하고 native 개인 런타임으로 우회하지 않습니다. native `service`와
`cutover prepare|verify|canary|rollback`은 런타임 관리로만 취급합니다. production,
database, rollback은 어댑터에 선언한 project backend capability와 정확히 하나의
`--revision <40자리 SHA>`가 모두 있어야 합니다. `artifacts list`는 조회지만
`artifacts prune`은 변경 명령이라 거부하고, `attachment --output`은 명시적인
`attachment-download` 정책에서만 허용합니다. `contact-window`와 `team_policy.work_hours`는
각각 연락과 변경을 판정하는 독립된 창이며 contact 확인은 backend를 실행하지 않습니다.
`PROJECT_GATEWAY_WORKSPACE`는 trusted host가 인증된 참가자에 대해 검증한 canonical 절대
workspace 경로입니다. issue-work와 high-impact project backend는 이 경로로 `cwd`를
고정해 실행하며, 등록부의 참가자 workspace와 일치하는 기존 디렉터리일 때만 전달합니다.
이 검사는 호스트 파일시스템 격리를 대신하지 않습니다. `policy_contract_version`이 없거나 `issue_work_roles`를 정하지 않은 기존
어댑터는 collaborator에게 권한을 추정해 주지 않고 명시적 마이그레이션을 요구합니다.
