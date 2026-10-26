# 교회 회계 프로그램 (호바트한인교회)

Cloudflare Workers + D1 기반 백엔드. 현재 구현: DB 구조, 로그인·권한, 기본 설정, 시작 잔액, **교적부**(직분·출석 상태 이력, 목양 시트 연동), 헌금 입력·내역, 변경 기록, 핸드폰용 화면.

> Cloudflare **Workers 유료 플랜**을 전제로 합니다. 헌금 50줄 저장, 시트 연동 100명 단위 전송은 한 요청에 수백 개의 DB 명령을 쓰며, 무료 플랜의 요청당 한도를 넘을 수 있습니다.
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
| `/api/members` | 교인 목록 (현재 직분·상태 포함), 시트에 없는 분 직접 추가 | 교적부 관리(목사) |
| `/api/registry/*` | 직분 목록, 직분 이력, 출석 상태 이력, 교인 상세(가족·연도별 헌금), 임기 만료 예정, 시트 연동 확인 대기 | 교적부 관리(목사) |
| `POST /api/registry/sync` | 목양 시트 → 교적부 (교인ID·가정ID·이름·관계·등록일 다섯 칸만, 토큰 인증) | 시트 스크립트 |
| `/api/offerings` | 헌금 (한 번에 여러 줄 저장, 기간·종류·성도·방식 조회, 취소) | 기록 담당 |
| `GET /api/offerings/summary` | 종류별·현금/온라인별 합계 (`member_id`로 개인별 합계) | - |
| `GET /api/audit-log` | 변경 기록 (누가·언제·무엇을, 이전/이후 값) | - |

권한: 재정 쓰기는 `editor`(기록 담당)만, 교적부 쓰기는 `registry_admin`(목사)만 가능합니다. 그 외는 조회만 됩니다. 삭제 기능은 없고 비활성화/취소 처리만 합니다.
금액은 센트 단위 정수(`amount_cents`)로 저장합니다.

## 로컬에서 실행

```sh
npm install
npm test                       # 테스트
npm run typecheck
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npx wrangler d1 execute church-accounting --local --file scripts/seed-dev.sql
npm run dev                    # 브라우저에서 http://localhost:8787 을 엽니다
```

열람 권한 화면을 보려면 `.dev.vars`의 `DEV_AUTH_EMAIL`을 열람 사용자 이메일로 바꾸고 그 사용자를 `users`에 추가한 뒤 다시 실행하세요.
로컬 데이터는 `.wrangler/` 폴더에만 저장됩니다. 시험용으로만 쓰세요.

## 배포 (아직 한 번도 실제 Cloudflare에 배포해 보지 않았습니다)

1. `npx wrangler d1 create church-accounting` → 출력된 `database_id`를 `wrangler.jsonc`에 입력
2. `npm run db:migrate:remote`
3. `scripts/add-user.example.sql`을 `scripts/add-user.sql`로 복사해 이메일을 고친 뒤 실행
4. Cloudflare Zero Trust에서 이 앱(예: `finance.교회도메인`)에 **Access 애플리케이션**을 만들고, 허용 이메일을 위 3명으로 제한
5. Access 애플리케이션의 **AUD 태그**와 팀 도메인(`<팀>.cloudflareaccess.com`)을 `wrangler.jsonc`의 `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`에 입력 (비어 있으면 모든 요청을 거부합니다)
6. `npx wrangler deploy`

`ENVIRONMENT`는 운영에서 `production`으로 두세요. `development`일 때만, 그리고 `localhost` 요청에서만 `DEV_AUTH_EMAIL` 로그인 우회가 동작합니다.

## 목양 시트 → 교적부 연동

목양 나눔 기록 시트는 목사님만 보는 자료입니다. 회계 서버는 그 시트에 **접근 권한이 없고**, 시트에 넣는 스크립트가 다섯 칸(교인ID·가정ID·이름·관계·등록일)만 골라서 보냅니다. 서버도 그 외의 칸이 오면 거부합니다.

1. 서버 쪽: `npx wrangler secret put SYNC_TOKEN` (32자 이상 임의 문자열)
2. 시트 쪽: [apps-script/registry-sync.gs](apps-script/registry-sync.gs) 맨 위 설명대로 붙여넣고, 스크립트 속성에 주소와 토큰을 넣고, `setupTriggers`를 한 번 실행
3. Cloudflare Access가 이 주소를 막고 있으므로, Access에서 **서비스 토큰**을 만들어 스크립트 속성 `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`에 넣고, Access 정책에 그 서비스 토큰을 허용하세요.

- 보내는 시점: 시트가 바뀔 때, 등록 스크립트가 `sendToRegistry()`를 부를 때, 메뉴 [교적부] → [지금 보내기]. 주기적으로 확인하지 않습니다.
- 다른 스크립트가 시트에 쓴 변경은 구글의 변경 트리거가 잡지 못합니다. 새가족 등록이 스크립트로 이루어진다면, 그 등록 코드 끝에 `sendToRegistry()` 한 줄을 넣으세요.
- 이미 직접 입력된 분과 이름이 같은 사람은 자동으로 만들지 않고 교적부 화면의 **확인 필요** 목록에 올립니다. 목사님이 "같은 분/새로 등록"을 고릅니다.
- 시트에서 사람을 지워도 교적부에서 지우거나 "떠남"으로 바꾸지 않습니다. 출석 상태는 교적부에서만 관리합니다.
- 로컬에서 시험: `.dev.vars`의 `SYNC_TOKEN`으로 `curl -X POST localhost:8787/api/registry/sync -H "Authorization: Bearer <토큰>" -H "Content-Type: application/json" -d '{"people":[...]}'`
