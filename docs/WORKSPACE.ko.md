# 작업공간 레이아웃

이 ADK는 **규칙 저장소**다. 제품 소스와 한 디렉터리에 섞지 않는다.

## 디렉터리

```text
<adk-root>/                         ← 이 저장소 (naia-pj-adk)
├── README.md                       ← 사람용 입구
├── AGENTS.md / CLAUDE.md / GEMINI.md
├── docs/
├── data-branch/<git-브랜치>/       ← 브랜치 전용 에이전트 컨텍스트
├── projects/                       ← 추적되는 프로젝트 어댑터만
│   ├── _template/
│   └── <project>/
├── checkouts/                      ← 로컬 git clone. 이 저장소에 올리지 않음
└── ops/gateway/                    ← 게이트웨이 감시 부품
```

`projects/`에 제품 레포를 clone 하지 않는다. 어댑터와 소스가 한 폴더에 있으면
하네스와 코드를 구분하지 못한다. 소스는 `checkouts/<저장소이름>/`에 둔다.

## 브랜치 두 종류

| | 이 ADK 저장소 | 제품 저장소 |
|--|---------------|-------------|
| 통합 브랜치 | `main` (이 레포) | 어댑터의 `integration_branch` (보통 `dev`) |
| 개인 작업 | `issue/<번호>-설명` | 같은 패턴의 제품 브랜치 |

ADK `main`에 머지해도 제품 사이트가 바뀌지 않는다.

## 브랜치별 컨텍스트

공통 `AGENTS.md`를 읽은 뒤 `data-branch/<현재-브랜치>/AGENTS.md`가 있으면 얹는다.
브랜치 이름의 `/`는 폴더다. `AGENTS.md`와 `CLAUDE.md`는 같은 내용이어야 한다.
없으면 `data-branch/_template/`만 본다.

## 운영 CLI

프로젝트 게이트웨이가 있으면 `ops/gateway/dcg.sh`가 그 CLI로 보낸다.
`NAIA_ADK_ROOT`가 있고 `NAIA_DCG_BACKEND=adk`이면 naia-adk
`manage-discord-sessions` 스크립트를 부른다. 토큰 소유 게이트웨이는 호스트당 하나다.

```bash
./ops/gateway/dcg.sh status
./ops/gateway/dcg.sh jobs --active
```
