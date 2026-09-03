# data-branch/

git 브랜치마다 다른 에이전트 컨텍스트를 둔다. 공통 `AGENTS.md` 위에 얹는다.

경로 = 브랜치 이름. `/` 는 하위 디렉터리다.

| 브랜치 | 읽는 파일 |
|--------|-----------|
| `main` | `data-branch/main/AGENTS.md` |
| `issue/12-banner` | `data-branch/issue/12-banner/AGENTS.md` |

각 폴더의 `AGENTS.md`와 `CLAUDE.md`는 바이트 단위로 같아야 한다.
시크릿·개인 Discord ID·호스트 주소는 넣지 않는다.
