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
| `POST /api/registry/sync` | 목양 시트 → 교적부 (일곱 칸만, 토큰 인증) | 시트 스크립트 |
| `POST /api/registry/import` | 같은 내용을 CSV 가져오기 화면에서 | 교적부 관리(목사) |
| `/api/offerings` | 헌금 (한 번에 여러 줄 저장, 기간·종류·성도·방식 조회, 취소). 교인이 아닌 방문자는 `visitor_name`·`visitor_from`(둘 다 선택)으로 기록 | 기록 담당 |
| `GET /api/offerings/summary` | 종류별·현금/온라인별 합계 (`member_id`로 개인별 합계) | - |
| `/api/expenses`, `/api/recurring-expenses` | 지출 (입력·수정·지급·취소), 고정 지출(사례비·렌트 등)과 이번 주 알림 | 기록 담당 |
| `POST /api/expenses/:id/attachments` (이미지 본문), `GET /api/expenses/:id/attachments`, `GET /api/attachments/:id`, `POST /api/attachments/:id/void` | 영수증 사진 (R2 `church-receipts`에 저장, 지출 하나에 10장·장당 10MB까지, JPEG·PNG·WEBP만, 지우기 대신 사유와 함께 취소) | 기록 담당 |
| `GET /api/reports/summary?from=&to=` | 기간 보고: 현금/은행 기간 시작·끝 잔액, 수입(헌금 종류별), 지출(부서별·항목별), 미지급 고정 지출 | - |
| `GET /api/reports/{offerings,expenses,summary}.csv?from=&to=` | 같은 기간의 헌금 내역·지출 내역·요약을 CSV로 (엑셀·넘버스·구글 시트) | - |
| `GET /api/audit-log` | 변경 기록 (누가·언제·무엇을, 이전/이후 값) | - |

권한: 헌금·지출 기록은 `editor`(기록 담당)만 가능합니다. **교인 명부(보기·쓰기)와 모두가 고르는 목록(헌금 종류·직분·부서·지출 항목)의 추가·이름 변경·빼기는 `registry_admin`(목사)만** 가능하고, 기록 담당은 고르기만 합니다. **누가 얼마를 냈는지는 기록 담당에게 최근 7일분만** 보이고(입력 확인용), 그보다 오래된 헌금은 이름 없이 금액만 보입니다. 성도별 조회·합계, 헌금 CSV의 이름·교인ID, 변경 기록의 헌금자 정보는 목사님만 봅니다. 기록 담당은 헌금 입력에 필요한 교인 이름(같은 이름을 구분할 직분·출생연도)만 받고, 변경 기록에서도 교적부 항목은 보이지 않습니다. 삭제 기능은 없고 비활성화/취소 처리만 합니다.
금액은 센트 단위 정수(`amount_cents`)로 저장합니다.

## 교인 탭 (교인 명부)

회계 앱에는 헌금을 사람·가정별로 묶는 데 필요한 **교인 명부**만 둡니다: 교인ID·가정ID·이름·직분, 그리고 교회 회계연도별 **가정별/개인별 헌금 합계**(무기명·방문자 헌금 제외).
직분 이력, 출석 상태(떠남·복귀), 임기 만료 알림, 교인 상세 화면이 있던 **전체 교적부 화면은 `archive/registry-full` 브랜치에 보관**했습니다. 서버의 교적부 API와 데이터(직분·상태 이력 표)는 그대로 남아 있어, 나중에 다른 곳에서 다시 쓸 수 있습니다.

## 분기별 점검 (보고·기록 탭)

- **기준**: 교회 회계연도(설정의 시작 월, 기본 1월) 또는 호주 회계연도(기본 7월)를 고릅니다. 연도와 연간/1~4분기/직접 지정을 고르면 날짜가 자동으로 채워집니다. 마지막 선택은 그 기기에 기억됩니다.
- **화면**: 현금·은행 각각 기간 시작 잔액 + 수입 − 지출 = 기간 끝 잔액. 취소된 헌금·지출과 아직 지급하지 않은 고정 지출은 합계에 들어가지 않습니다.
- **내보내기**: 요약·헌금 내역·지출 내역 CSV. 취소된 줄도 '상태'·'취소 사유'와 함께 들어 있고, '합계에 포함' 열을 더하면 화면의 합계와 같습니다. 엑셀이 한글을 깨뜨리지 않도록 UTF-8 BOM을 붙이고, `=`, `+`, `-`, `@`로 시작하는 글자는 수식으로 실행되지 않게 앞에 `'`를 붙입니다.
- **아직 없는 것**: 현금을 은행에 입금하는 '이체' 기록. 지금은 입금해도 현금·은행 잔액이 따로 움직이지 않으니, 합계(현금+은행)로 보시거나 이체 기능이 생길 때까지 시작 잔액 기준일을 다시 잡아야 합니다.

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

**실제 배포는 [DEPLOY.md](DEPLOY.md)를 따르세요** (주소: `finance.hobartchurch.org`, 하지 말 것 목록, 배포 후 확인 포함). 아래는 요약입니다.

1. `npx wrangler d1 create church-accounting` → 출력된 `database_id`를 `wrangler.jsonc`에 입력
2. `npm run db:migrate:remote`
3. `scripts/add-user.example.sql`을 `scripts/add-user.sql`로 복사해 이메일을 고친 뒤 실행
4. Cloudflare Zero Trust에서 이 앱(예: `finance.교회도메인`)에 **Access 애플리케이션**을 만들고, 허용 이메일을 위 3명으로 제한
5. Access 애플리케이션의 **AUD 태그**와 팀 도메인(`<팀>.cloudflareaccess.com`)을 `wrangler.jsonc`의 `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`에 입력 (비어 있으면 모든 요청을 거부합니다)
6. `wrangler.jsonc`에 Access로 보호되는 주소를 `routes`로 추가 (예: `{ "pattern": "finance.교회도메인", "custom_domain": true }`). `workers.dev` 주소와 미리보기 주소는 꺼 두었습니다.
7. `npx wrangler secret put SYNC_TOKEN` (시트 연동을 쓸 때)
8. `npx wrangler deploy`

`ENVIRONMENT`는 운영에서 `production`으로 두세요. `development`일 때만, 그리고 `localhost` 요청에서만 `DEV_AUTH_EMAIL` 로그인 우회가 동작합니다.

## 목양 시트 → 교적부 연동

목양 나눔 기록 시트는 목사님만 보는 자료입니다. 회계 서버는 그 시트에 **접근 권한이 없고**, 시트에 넣는 스크립트(또는 교적부 화면의 CSV 가져오기)가 일곱 칸(교인ID·가정ID·이름·관계·생년월일·직분·등록일)만 골라서 보냅니다. 서버도 그 외의 칸이 오면 거부합니다. 직분은 처음 등록할 때만 쓰이고(시트의 '집사'는 '서리집사'로), 그 뒤 직분 변경은 교적부에서 합니다.

서버 배포 전에는 교적부 화면의 **목양 시트에서 가져오기 (CSV)**로 같은 일을 할 수 있습니다.

1. 서버 쪽: `npx wrangler secret put SYNC_TOKEN` (32자 이상 임의 문자열)
   - 이 토큰은 시트의 스크립트 속성에 저장되므로, **시트 편집 권한이 있는 사람은 볼 수 있습니다.** 목양 시트의 편집 권한은 목사님만 가지시고, 공유 범위가 바뀌면 토큰을 새로 바꾸세요.
2. 시트 쪽: [apps-script/registry-sync.gs](apps-script/registry-sync.gs) 맨 위 설명대로 붙여넣고, 스크립트 속성에 주소와 토큰을 넣고, `setupTriggers`를 한 번 실행
3. Cloudflare Access가 이 주소를 막고 있으므로, Access에서 **서비스 토큰**을 만들어 스크립트 속성 `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`에 넣고, Access 정책에 그 서비스 토큰을 허용하세요.

- 보내는 시점: 시트가 바뀔 때, 등록 스크립트가 `sendToRegistry()`를 부를 때, 메뉴 [교적부] → [지금 보내기]. 주기적으로 확인하지 않습니다.
- 다른 스크립트가 시트에 쓴 변경은 구글의 변경 트리거가 잡지 못합니다. 새가족 등록이 스크립트로 이루어진다면, 그 등록 코드 끝에 `sendToRegistry()` 한 줄을 넣으세요.
- 이미 직접 입력된 분과 이름이 같은 사람은 자동으로 만들지 않고 교적부 화면의 **확인 필요** 목록에 올립니다. 목사님이 "같은 분/새로 등록"을 고릅니다.
- 시트에서 사람을 지워도 교적부에서 지우거나 "떠남"으로 바꾸지 않습니다. 출석 상태는 교적부에서만 관리합니다.
- 로컬에서 시험: `.dev.vars`의 `SYNC_TOKEN`으로 `curl -X POST localhost:8787/api/registry/sync -H "Authorization: Bearer <토큰>" -H "Content-Type: application/json" -d '{"people":[...]}'`
