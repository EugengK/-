# 교회 회계 프로그램 (호바트한인교회)

Cloudflare Workers + D1 기반 백엔드. 현재는 **1단계**(DB 구조, 로그인·권한, 기본 설정, 시작 잔액)까지 구현되어 있습니다.
기획은 [docs/PLAN.md](docs/PLAN.md) 참고.

## 구현된 API (모두 로그인 필요, `/api/health` 제외)

| 경로 | 설명 | 쓰기 권한 |
|---|---|---|
| `GET /api/me` | 내 정보 | - |
| `GET /api/users`, `GET /api/settings` | 사용자 목록, 설정(교회 이름, 회계연도 시작 월 등) | - |
| `/api/fund-types` | 헌금 종류 (조회·추가·수정·비활성화) | 기록 담당 |
| `/api/departments` | 부서 | 기록 담당 |
| `/api/expense-categories` | 지출 항목 | 기록 담당 |
| `/api/opening-balances` | 시작 잔액 (현금/은행 각 1건, 수정 대신 취소 후 재입력) | 기록 담당 |
| `GET /api/audit-log` | 변경 기록 (누가·언제·무엇을, 이전/이후 값) | - |

권한: `editor`(기록 담당)만 쓰기 가능, `viewer`(열람)는 조회만 가능. 삭제 기능은 없고 비활성화/취소 처리만 합니다.
금액은 센트 단위 정수(`amount_cents`)로 저장합니다.

## 로컬에서 실행

```sh
npm install
npm test                       # 테스트
npm run typecheck
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npx wrangler d1 execute church-accounting --local --file scripts/seed-dev.sql
npm run dev                    # http://localhost:8787/api/me
```

## 배포 (아직 한 번도 실제 Cloudflare에 배포해 보지 않았습니다)

1. `npx wrangler d1 create church-accounting` → 출력된 `database_id`를 `wrangler.jsonc`에 입력
2. `npm run db:migrate:remote`
3. `scripts/add-user.example.sql`을 `scripts/add-user.sql`로 복사해 이메일을 고친 뒤 실행
4. Cloudflare Zero Trust에서 이 앱(예: `finance.교회도메인`)에 **Access 애플리케이션**을 만들고, 허용 이메일을 위 3명으로 제한
5. Access 애플리케이션의 **AUD 태그**와 팀 도메인(`<팀>.cloudflareaccess.com`)을 `wrangler.jsonc`의 `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`에 입력 (비어 있으면 모든 요청을 거부합니다)
6. `npx wrangler deploy`

`ENVIRONMENT`는 운영에서 `production`으로 두세요. `development`일 때만, 그리고 `localhost` 요청에서만 `DEV_AUTH_EMAIL` 로그인 우회가 동작합니다.
