# data-branch/_template

새 브랜치 컨텍스트를 만들 때 이 파일을 복사한다. 같은 내용을 `CLAUDE.md`에도 둔다.

채울 항목:

- 이 브랜치가 가리키는 어댑터 (`projects/<id>/`)
- 제품 checkout 경로 (`checkouts/<repo>/`, 있으면)
- 확인 URL은 어댑터 `project.yaml`의 tier 만 사용. 여기에 호스트를 새로 적지 않는다.
- 이 브랜치의 통합 tier와 main-only 여부
- 이슈·역할·승인·근무시간은 어댑터 `team_policy`를 따른다.
- 토큰, 비밀번호, 참가자 ID, 사설 호스트·운영 상태·runner 상태를 기록하지 않는다.
- 이슈 브랜치에서 검증하고, production 변경은 명시적 승인·환경·롤백 증거가 없으면 하지 않는다.
- 이 브랜치에서 하면 안 되는 것
