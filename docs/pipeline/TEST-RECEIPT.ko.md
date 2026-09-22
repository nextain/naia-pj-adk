# 통합 시험(IT) / E2E 시험 영수증 표준 양식

관련 계약: `.agents/context/development-method.yaml`(변경 분류, 사용자 시나리오, 기능 명세). 이 문서는 그 위에 시험 순서와 영수증 규칙을 사람이 읽는 말로 적는다.  

이 문서는 통합 시험(IT) 및 사용자 여정 관통 시험(E2E)의 결과를 기록하는 표준 영수증 양식이다.  
실행한 시험 수·실패 수·종료 코드를 정량 칸으로 두어 **"실패가 있는데 완료로 닫음"**이나 **"Mock 테스트를 실제 통합 관통으로 둔갑"**시키는 거짓 완료를 원천 방지한다.

---

## 1. 필수 기재 항목 (Receipt Fields)

모든 IT 및 E2E 영수증은 다음 항목을 누락 없이 포함해야 한다.

### 1.1 메타데이터
- **Receipt ID**: 영수증 고유 식별자 (예: `RECEIPT-IT-APP-12-20260922-01`)
- **Test Type**: `IT` (화면 없이 실제 백엔드 관통) 또는 `E2E` (실제 화면에서 실제 백엔드까지 관통)
- **E2E 해당 없음(N/A)**: `N/A` (화면 없는 제품 단위) 또는 `REQUIRED` (기본값)
- **SP Section Reference (SP 근거 절)**: *[E2E N/A인 경우 필수]* 화면기획(SP)에 해당 화면이 없음을 확인한 SP 문서 경로 및 구체적 절 번호 (예: `docs/sp.md#sp-00`). 구현자 임의 판단이 아닌 SP 기준이어야 함.
- **Issue**: 연계된 GitHub 이슈 번호 (예: `your-org/your-app#12`)
- **Manifest Unit / REQ-IDs**: 연계된 요구사항 단위 (예: `FE-01`, `REQ-002`)
- **Target Repository**: 시험 대상 코드 저장소 (예: `your-org/your-app`, `your-org/your-service`)
- **Target Commit**: 시험 실행 시점의 커밋 SHA (`git rev-parse HEAD`)
- **Device & Session**: 실행 기기 ID (예: `your-device`) 및 세션 식별자
- **Timestamp**: 시험 완료 일시 (ISO 8601)

### 1.2 산술적 검증 결과 (Arithmetic Outcome)
칸으로 명시하여 실패가 있으면 완료로 닫을 수 없음을 기계적으로 확인한다:
- **Total Tests (실행한 시험 수)**: N
- **Passed (통과 수)**: N
- **Failed (실패 수)**: N
- **Skipped (건너뜀 수)**: N
- **Exit Code (종료 코드)**: 0 (성공) / 비 0 (실패)

> ⛔ **엄격 규칙**: `Failed > 0` 또는 `Exit Code != 0`인 경우 상태는 무조건 `FAILED` 또는 `BLOCKED`이며, 어떠한 경우에도 `succeeded`나 `IMPLEMENTATION_COMPLETE`로 닫을 수 없다. 생략(Skipped)한 시험은 PASS가 아니며 반드시 그 사유를 명시해야 한다.

### 1.3 실행 환경 및 실물 경로
- **Tested Address (시험한 실제 주소)**: API 엔드포인트, 소켓, 또는 로컬 서버 주소 (예: `http://localhost:<PORT>/api/v1/...`, 외부 접근 경로 등)
- **Artifact Path (산출물 파일 경로)**: 시험 실행 결과로 디스크에 생성된 실제 결과물 경로 (예: `tmp/test-output/sample.wav`, 생성된 결과 파일, 로그 등)
- **Preceding IT Receipt (선행 IT 영수증)**: *[E2E인 경우 필수]* 같은 이슈의 통과된 선행 IT 영수증 경로 및 커밋 SHA.

---

## 2. 리뷰어가 확인할 세 가지 핵심 질문 (Reviewer Verification)

독립 리뷰어는 영수증을 승인하기 전에 반드시 다음 세 질문을 원자료로 직접 검증해야 한다:

| 번호 | 점검 질문 | 검증 방법 및 기준 | 실패 판정 사유 |
|---|---|---|---|
| **Q1** | **시험한 주소가 그 기능의 실제 경로인가?** | 코드베이스 및 라우팅 설정 대조. 실제 백엔드 컴포넌트(DB, 게이트웨이, 워커)로 연결되는 실제 엔드포인트인지 확인. | 모의 객체(mock worker)로 대기열만 돌렸거나, 존재하지 않는 가짜 경로를 시험한 경우 무효. |
| **Q2** | **산출물 파일이 실제로 존재하며 직접 열어 보았는가?** | 명시된 `Artifact Path`의 파일을 직접 열어 바이트 크기, 포맷, 실제 응답 내용 확인. | 파일이 없거나(ENOENT), 0바이트이거나, 실패 결과를 고정 시료로 반환한 경우 무효. |
| **Q3** | **화면 결과(E2E)가 같은 이슈의 유효한 IT 영수증을 가리키는가? (화면 없는 단위는 SP 근거 확인)** | E2E 영수증에 링크된 IT 영수증의 Commit SHA, Issue ID, 통과 여부를 교차 확인. 화면 없는 제품 단위인 경우 SP에 해당 화면이 없다는 근거 절이 올바른지 확인. | 선행 IT 영수증이 없거나, 다른 이슈의 영수증이거나, 백엔드 관통 없이 화면만 먼저 구현한 경우 무효. SP에 화면이 있는데 백엔드만 바뀌었다고 E2E를 생략한 경우 무효. |

---

## 3. 마크다운 영수증 템플릿 (복사하여 사용)

````markdown
# [IT | E2E] Test Receipt: {기능 요약}

## 1. Metadata
- **Receipt ID**: RECEIPT-{IT|E2E}-{ISSUE}-{YYYYMMDD}-{SEQ}
- **Test Type**: IT | E2E
- **E2E 해당 없음(N/A)**: N/A | REQUIRED
- **SP Section Reference** *(E2E N/A인 경우 필수)*: {SP 문서 경로 및 해당 화면 부재 확인 절 (예: docs/sp.md#sp-NN)}
- **Issue**: your-org/your-app#{NUMBER}
- **Manifest Unit / REQ-IDs**: FE-{NN}, REQ-{NNN}
- **Target Repository**: your-org/{REPO}
- **Target Commit**: {COMMIT_SHA}
- **Device & Session**: {DEVICE_ID} / {SESSION_ID}
- **Executed At**: {YYYY-MM-DDTHH:MM:SSZ}

## 2. Arithmetic Results
| Total Tests | Passed | Failed | Skipped | Exit Code | Final Verdict |
|:-----------:|:------:|:------:|:-------:|:---------:|:-------------:|
|      4      |   4    |   0    |    0    |     0     |     PASS      |

*규칙: Failed가 1건이라도 있거나 Exit Code가 0이 아니면 PASS 선언 불가. 생략(Skipped)한 시험은 PASS가 아니며 반드시 그 사유를 명시해야 한다.*

## 3. Environment & Artifacts
- **Tested Address**: http://localhost:{PORT}/api/...
- **Artifact File Path**: {REPO_RELATIVE_PATH}/... (실제 생성 파일)
- **Artifact File Size / Type**: {BYTES} bytes / {MIME_TYPE}
- **Preceding IT Receipt** *(E2E 필수)*: docs/receipts/... (또는 영수증 파일 경로)

## 4. Test Execution Command & Output Log
```bash
# 실행한 실제 명령어
pytest tests/integration/test_real_backend.py -v
```

<details>
<summary>실행 로그 출력 펼치기</summary>

```text
{실제 테스트 러너의 표준 출력 및 종료 로그}
```
</details>

## 5. 리뷰어 확인 항목 (Reviewer Verification Checklist)
- [ ] Q1. 시험한 주소가 그 기능의 실제 경로임을 코드/라우팅으로 확인했는가?
- [ ] Q2. 산출물 파일을 파일시스템에서 직접 열어 실제 내용을 확인했는가?
- [ ] Q3. (E2E인 경우) 화면 결과가 같은 이슈의 통과된 IT 영수증을 가리키는가? (화면 없는 단위인 경우 SP에 해당 화면이 없음을 확인했는가?)
- **Reviewer Signature**: {REVIEWER_ID} ({MODEL_NAME}) - {APPROVED | REJECTED}
````
