# issue/discord-lifecycle-contract

이 브랜치는 특정 제품 어댑터가 아니라 naia-pj-adk 공통 게이트웨이 부품을 다룬다.
작업 정본과 검증·리뷰 증거는 [이슈 #12](https://github.com/nextain/naia-pj-adk/issues/12)에 둔다.

- 통합 대상은 `main`이다. 이 브랜치에는 제품 checkout이나 배포 tier가 없다.
- 구현 기준 커밋은 `a72e8e0ef3d7d94b76dd5cf1e328bd862bfabdbf`이다.
- 공통 계약은 `.agents/context/discord.yaml`의 `issue_lifecycle`,
  구현은 `ops/gateway/issue_lifecycle.py`, 도입 안내는 `ops/gateway/README.ko.md`다.
- `schemas/followups.schema.json`은 기존 v1 읽기 호환을 유지한다.
  새 함수 사용 전 어댑터가 저장소 소유자까지 포함한 키를 명시적으로 확정해야 한다.
- 기존 연결은 대화 속 교차 참조보다 우선한다. 허용되지 않거나 충돌하는 연결은
  다른 이슈로 대체하지 않는다. 작업 시각은 문자열 순서가 아니라 실제 시각으로 비교한다.
- 실행 종료, 이슈 닫힘, 사람 확인 대기, 응답 전달은 독립된 상태다.
  시스템 이벤트로 답변 의무를 지우지 않는다.
- 검증 명령은 Node 20 이상에서 `npm test`와 `git diff --check`다.
  회귀 시험만 실행하려면 `npm run test:issue-lifecycle`을 사용한다.
- 이어서 작업할 때는 먼저 이슈와 PR의 현재 상태, 원격 브랜치와 CI 결과를 조회한다.
  문서에 남은 과거 결과를 현재 상태로 간주하지 않는다.
- 공통 부품의 시험 통과를 실제 프로젝트 배포 완료로 보고하지 않는다.
  실제 도입은 해당 어댑터의 권한·키 마이그레이션·전체 쓰기 경로와 현재 실행 증거를 확인한다.
- 이 브랜치에서 실제 Discord 메타데이터, 메시지, 실행 DB나 운영 설정을 변경하지 않는다.
  비공개 식별자·실행 로그·호스트별 세션 바인딩을 공유 컨텍스트에 넣지 않는다.
- 되돌리기는 해당 변경 커밋의 revert다. 향후 어댑터 도입 시에는 별도로
  이전 어댑터와 추적표 백업을 확보하고 동시 쓰기를 통제해야 한다.
