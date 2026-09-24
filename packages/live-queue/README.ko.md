# 실시간 공통 큐

여러 기기가 즉시 같은 기록을 읽고 써야 할 때의 저장소입니다. 정본은 Postgres
데이터베이스 `naia_comm`의 `live_queue_records` 테이블입니다. 다른 기기는 그
데이터베이스 포트로 붙지 않고 이 HTTP API만 호출합니다.

회차 집행기의 Git 커밋 큐는 그대로입니다. 그 큐는 수신·시작·종료 영수증의
기록이고, 이 저장소는 그 사이 여러 PC가 같이 보는 실시간 문서입니다.

## 데이터베이스 바꾸기

서버의 기본 접속 주소는 `postgresql://localhost:5432/naia_comm`입니다.
`NAIA_QUEUE_DATABASE_URL`을 다른 Postgres 주소로 바꾸면 그 데이터베이스가
정본이 됩니다. 주소가 비어 있으면 기본값을 씁니다. 테스트는 `memory://`를
쓰고, 그 값은 프로세스 안에만 있으며 재시작되면 사라집니다.

서버는 시작할 때 테이블이 없으면 만듭니다. 컬렉션과 문서 내용은 호출자가
정합니다. 한 문서는 JSON 객체이고 256KiB를 넘지 않습니다. `If-Match`에 현재
revision을 넣으면 그 revision이 아닐 때 409를 돌려 덮어쓰지 않습니다.

## 환경 변수

| 변수 | 기본 | 의미 |
|---|---|---|
| `NAIA_QUEUE_DATABASE_URL` | `postgresql://localhost:5432/naia_comm` | 정본 데이터베이스 |
| `NAIA_QUEUE_BIND` | `localhost` | 서버가 듣는 주소. loopback이 아니면 자격 증명이 필수 |
| `NAIA_QUEUE_PORT` | `8096` | 서버 포트 |
| `NAIA_QUEUE_API_TOKEN` | 비어 있음 | 있으면 `Authorization: Bearer`가 맞아야 읽기·쓰기가 된다. `/health`는 예외 |
| `NAIA_QUEUE_BASE_URL` | `http://localhost:8096` | 클라이언트가 호출할 API. 끝의 `/`는 무시 |

자격 증명 값은 저장소에 두지 않습니다. 배포 환경 파일은 저장소 밖입니다.

## 실행

```
PYTHONPATH=packages/live-queue python3 -m live_queue serve
```

의존성은 `requirements.txt`입니다. `memory://`로 시험할 때는 설치하지 않아도 됩니다.

## API

- `GET /health` → `{"ok":true,"ready":true,"store":"postgres"}` 또는 `store`가 `memory`
- `GET /v1/<collection>`
- `GET /v1/<collection>/<id>`
- `PUT /v1/<collection>/<id>` 본문은 JSON 객체
- `DELETE /v1/<collection>/<id>`

컬렉션 이름은 소문자로 시작하고 영숫자와 `_`만 씁니다. 예: `items`, `claims`,
`receipts`, `heartbeats`.

Node 클라이언트는 `client.mjs`입니다. Python에서 저장소를 직접 열 때는
`live_queue.open_store`를 씁니다. 다른 기기의 코드는 HTTP 클라이언트만 씁니다.

## 배포 단위

`deploy/naia-live-queue.service`는 환경 파일 `/etc/naia-live-queue.env`를
읽습니다. 그 파일에 데이터베이스 주소와 자격 증명을 둡니다. 제품 게이트웨이
프로세스에 이 경로를 넣지 않습니다. 프록시는 이 서비스의 포트만 가리키면 됩니다.
