# 배포 지시서 — finance.hobartchurch.org

이 문서는 사람이든 AI 도구(Codex 등)든 **이 순서 그대로** 따라 하도록 쓴 것입니다.
교회 재정과 교인 정보를 다루는 프로그램이므로, 아래의 "하지 말 것"은 예외 없이 지켜 주세요.
어느 단계든 예상과 다른 결과가 나오면 **추측해서 고치지 말고 멈춘 뒤 목사님께 보고**합니다.

## 0. 확정된 사항

| 항목 | 값 |
|---|---|
| 저장소 / 브랜치 | `eugengk/-` 의 `claude/church-accounting-plan` 브랜치 |
| 앱 주소 | `https://finance.hobartchurch.org` (이미 `wrangler.jsonc`의 `routes`에 들어 있음) |
| Worker 이름 | `church-accounting` |
| D1 데이터베이스 이름 | `church-accounting` |
| 사용자 | 3명 — 기록 담당 2명(`editor`), 담임목사 1명(`viewer` + 교적부 관리 `registry_admin=1`) |

## 하지 말 것 (절대)

1. **`hobartchurch.org`(교회 홈페이지)와 그 DNS 레코드, 기존 Worker/Pages 프로젝트를 건드리지 않는다.** 이 앱은 `finance.hobartchurch.org` 하나에만 붙는다.
2. `scripts/seed-dev.sql`을 실제 서버(`--remote`)에 실행하지 않는다. (개발용 가짜 사용자가 들어감)
3. `ENVIRONMENT`를 `development`로 바꾸거나 `DEV_AUTH_EMAIL`을 서버에 설정하지 않는다. (로그인 우회)
4. `workers_dev`, `preview_urls`를 `true`로 바꾸지 않는다. (로그인 보호 없는 주소가 생김)
5. 실제 이메일이 든 `scripts/add-user.sql`, 백업 파일, 토큰 값을 **git에 커밋하지 않는다.** (`scripts/add-user.sql`, `backups/`는 `.gitignore`에 있음)
6. **목사님의 목양 나눔 기록 구글 시트를 열거나 읽거나 수정하지 않는다.** 시트 연동(8단계)은 목사님이 직접 한다.
7. 실제 데이터가 들어간 뒤에는 D1 데이터베이스를 삭제하거나 다시 만들지 않는다.

## 1. 준비 확인

**브라우저 자동화 없이 진행한다.** 이 문서의 명령은 모두 터미널에서 실행한다.
Cloudflare 대시보드에서 해야 하는 일(아래 1-A, 4단계)은 AI 도구가 브라우저를 직접 조작하지 말고 **목사님께 요청**한다.

### 1-A. 목사님이 직접 (Cloudflare 대시보드, 브라우저)

- 왼쪽 메뉴 **Websites(도메인)** 목록에 `hobartchurch.org`가 있는지
- **Workers & Pages → Plans**(요금제)에서 **Workers Paid**가 켜져 있는지
  (무료 플랜은 요청 하나당 D1 쿼리 수 제한이 작아(50개) 헌금 여러 줄 저장 등이 실패할 수 있다.)
- 맥의 터미널에서 이 저장소 폴더로 가서 Cloudflare 로그인 (브라우저 창이 열리면 **허용**):

```sh
npx wrangler login
```

  로그인 정보는 이 맥에 저장되므로, 같은 맥에서 일하는 AI 도구도 이후 명령을 쓸 수 있다.
  (AI 도구가 맥이 아닌 다른 곳(클라우드)에서 돌아간다면 이 로그인이 전달되지 않는다 — 그 경우 멈추고 보고한다.)

### 1-B. AI 도구가 (터미널)

```sh
git checkout claude/church-accounting-plan && git pull
npm ci
npx tsc --noEmit
npx vitest run                         # 전부 통과해야 함
npx wrangler whoami                    # 로그인된 계정 이름 확인 → 목사님께 보여 드리고 맞는지 확인
dig +short finance.hobartchurch.org    # 아무것도 안 나와야 정상
```

- `wrangler whoami`가 로그인 안 됨으로 나오면 멈추고 목사님께 1-A의 로그인을 요청한다. **브라우저를 직접 띄우려 하지 않는다.**
- `dig` 결과가 나오면(이미 그 주소가 쓰이는 중) 멈추고 보고한다.

## 2. 데이터베이스 만들기

```sh
npx wrangler d1 create church-accounting
```

출력된 `database_id`를 `wrangler.jsonc`의 `"database_id"`(지금은 `00000000-...`)에 넣는다. 그다음:

```sh
npm run db:migrate:remote
npx wrangler d1 execute church-accounting --remote --command "SELECT name FROM fund_types ORDER BY sort_order"
```

헌금 종류 6개(주일헌금, 십일조, 선교헌금, 건축헌금, 작정헌금, 감사헌금)가 나오면 정상.

## 3. 사용자 3명 등록

```sh
cp scripts/add-user.example.sql scripts/add-user.sql
```

`scripts/add-user.sql`의 이메일·이름을 목사님께 받은 **실제 3명**으로 고친다. 이 이메일은 4단계 Access 로그인에 쓰는 것과 **똑같아야** 한다.
담임목사 줄은 반드시 `role = 'viewer'`, `registry_admin = 1` 그대로 둔다.

```sh
npx wrangler d1 execute church-accounting --remote --file scripts/add-user.sql
npx wrangler d1 execute church-accounting --remote --command "SELECT email, role, registry_admin, is_active FROM users WHERE email NOT LIKE '%@system.local'"
```

정확히 3줄이 나와야 한다. (`@system.local` 두 줄은 시스템용으로 원래 있고, 로그인할 수 없다.)

## 4. 로그인 보호 — Cloudflare Access (배포보다 먼저, **목사님이 대시보드에서**)

Cloudflare 대시보드 → Zero Trust → Access → Applications → **Self-hosted** 애플리케이션 추가
(메뉴 이름은 Cloudflare 화면 변경에 따라 조금 다를 수 있음)

- 도메인: `finance.hobartchurch.org` (경로 비움 = 전체)
- 정책: **Allow**, Include → **Emails** → 3단계의 이메일 3개만
- 로그인 방법: 이메일 일회용 코드(One-time PIN)면 충분

만든 뒤 두 값을 확인한다.

- 애플리케이션의 **Application Audience (AUD) Tag**
- 팀 도메인: `<팀이름>.cloudflareaccess.com`

`wrangler.jsonc`의 `vars`에 넣는다.

```jsonc
"ACCESS_TEAM_DOMAIN": "<팀이름>.cloudflareaccess.com",
"ACCESS_AUD": "<AUD 태그>"
```

둘 중 하나라도 비어 있으면 앱이 **모든 요청을 거부**한다(안전 장치). 이 두 값은 비밀번호가 아니므로 커밋해도 된다.

## 4-1. 영수증 사진 저장소 (R2) 만들기 (한 번만)

```sh
npx wrangler r2 bucket create church-receipts
```

R2를 처음 쓰는 계정이면 대시보드에서 **R2 사용 시작**(약관 동의, 결제 수단 등록 요구 가능)을 먼저 해야 할 수 있다.
그 경우 멈추고 목사님께 요청한다. 이 저장소가 없으면 5단계 배포가 실패한다.

## 4-2. 영수증 자동 읽기 키 (Google Gemini, 선택)

결제가 연결된(유료 등급) Google AI Studio 프로젝트에서 **회계 전용 API 키**를 새로 만든 뒤, 목사님이 직접 넣는다(키를 채팅·깃허브에 붙여 넣지 않는다):

```sh
npx wrangler secret put GEMINI_API_KEY
```

키가 없으면 자동 읽기만 꺼지고(“아직 설정되지 않았습니다” 안내), 나머지는 그대로 동작한다.

## 5. 배포

```sh
npx tsc --noEmit && npx vitest run
npx wrangler deploy
```

`routes`의 `custom_domain: true` 때문에 Cloudflare가 `finance.hobartchurch.org` DNS 레코드와 인증서를 자동으로 만든다.

## 6. 배포 후 확인 (모두 통과해야 완료)

```sh
# 1) 로그인 안 한 요청은 Access 로그인 페이지로 돌려보내져야 함 (302, Location에 cloudflareaccess.com)
curl -sI https://finance.hobartchurch.org/ | grep -iE "^HTTP|^location"
curl -sI https://finance.hobartchurch.org/api/me | grep -iE "^HTTP|^location"

# 2) 교회 홈페이지는 이전과 똑같아야 함
curl -sI https://hobartchurch.org/ | head -1
```

브라우저에서(각자 자기 이메일로):

- 기록 담당 → 오른쪽 위에 "이름 · 재정 기록", **헌금 입력** 탭이 보임
- 담임목사 → "이름 · 재정 열람 · 교적부 관리", 헌금 입력 탭 없음, 교적부 탭에서 직분 기록 가능
- 등록되지 않은 이메일 → Access에서 막힘

이상이 없으면 3단계에서 만든 `scripts/add-user.sql`은 지워도 된다(커밋 금지).

## 7. 처음 쓰기 시작할 때 (목사님/기록 담당이 화면에서)

1. 설정 → **시작 잔액**: 합치는 날 기준 현금·은행 잔액
2. 설정 → 부서, 지출 항목
3. 교적부 → 교인명부 CSV 가져오기
4. 지출 → 고정 지출(사례비, 렌트) 등록

## 8. (선택, 나중에) 목양 시트 → 교적부 자동 연동

**목사님이 직접** 한다. README의 "목양 시트 → 교적부 연동" 참고.

1. `npx wrangler secret put SYNC_TOKEN` (32자 이상 임의 문자열)
2. Access에 **서비스 토큰**을 만들고, 이 애플리케이션 정책에 그 서비스 토큰을 허용(Service Auth)
3. 시트의 Apps Script에 `apps-script/registry-sync.gs`를 붙여넣고 스크립트 속성에 주소·토큰·서비스 토큰 입력

## 백업

- 화면: 보고·기록 → 내보내기(CSV) — 분기마다 받아 교회 드라이브에 보관
- 데이터베이스 전체:

```sh
mkdir -p backups
npx wrangler d1 export church-accounting --remote --output backups/church-$(date +%F).sql
```

백업 파일에는 교인 정보와 헌금 기록이 들어 있다. **git에 올리지 말고** 안전한 곳에 보관한다.
D1에는 Cloudflare 자체의 시점 복구(Time Travel) 기능도 있다(보관 기간은 플랜에 따라 다르므로 Cloudflare 문서 확인).

## 앱 코드를 고친 뒤 다시 올릴 때

```sh
git pull
npm ci
npx tsc --noEmit && npx vitest run
npm run db:migrate:remote   # 새 migrations 파일이 있을 때만 실제로 적용됨
npx wrangler deploy
```
