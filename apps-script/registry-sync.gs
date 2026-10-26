/**
 * 목양 나눔 기록 → 교적부 연동 (Google Apps Script)
 *
 * 이 스크립트는 '교인목록' 탭에서 다섯 칸만 골라 회계 서버의 교적부로 보냅니다:
 *   교인ID, 가정ID, 이름, 관계, 등록일 (최초등록일, 없으면 등록일시의 날짜)
 * 상담 내용, 신앙 상태, 기도제목, 주소, 생년월일 등 다른 칸은 읽지도 보내지도 않습니다.
 *
 * 설정 (한 번만):
 *   1. 시트 메뉴 [확장 프로그램] → [Apps Script] → 이 파일 내용을 붙여넣고 저장
 *   2. [프로젝트 설정] → [스크립트 속성]에 두 값 추가
 *        REGISTRY_URL    = https://(회계 주소)/api/registry/sync
 *        REGISTRY_TOKEN  = (회계 서버의 SYNC_TOKEN 과 같은 값)
 *      Cloudflare Access 서비스 토큰을 쓰는 경우 두 값 추가
 *        CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
 *   3. 편집기에서 setupTriggers 를 한 번 실행하고 권한을 허용
 *
 * 보내는 시점 (계속 확인하지 않고, 변화가 있을 때만):
 *   - 시트에 행이 추가·수정될 때 (onChange 트리거)
 *   - 등록 스크립트가 직접 호출할 때: 새가족 등록 코드 끝에 sendToRegistry() 한 줄 추가
 *   - 시트 메뉴 [교적부] → [지금 보내기]
 */

const SHEET_NAME = '교인목록';
const COLUMNS = { member_code: '교인ID', family_code: '가정ID', name: '이름', relation: '관계', registered_at: '등록일시' };
// Optional: when filled, the original registration date is used instead of the sheet entry time.
const FIRST_REGISTERED = '최초등록일';
const CHUNK = 100; // the server accepts up to 100 people per request

function onOpen() {
  SpreadsheetApp.getUi().createMenu('교적부').addItem('지금 보내기', 'sendToRegistryWithAlert').addToUi();
}

/** Run once from the editor. Installs the change trigger (no timers, no polling). */
function setupTriggers() {
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'onSheetChange')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
}

function onSheetChange() {
  // Several quick edits in a row would each fire; the lock makes them queue instead of overlap.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    sendToRegistry();
  } finally {
    lock.releaseLock();
  }
}

function sendToRegistryWithAlert() {
  const r = sendToRegistry();
  SpreadsheetApp.getUi().alert(`교적부 연동 완료\n새로 등록: ${r.created}명, 변경: ${r.updated}명, 그대로: ${r.unchanged}명`);
}

/** Reads the five allowed columns and sends them. Returns totals. */
function sendToRegistry() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('REGISTRY_URL');
  const token = props.getProperty('REGISTRY_TOKEN');
  if (!url || !token) throw new Error('스크립트 속성 REGISTRY_URL / REGISTRY_TOKEN 이 없습니다.');

  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`'${SHEET_NAME}' 탭을 찾을 수 없습니다.`);
  const values = sheet.getDataRange().getValues();
  const header = values[0].map((v) => String(v).trim());
  const col = {};
  for (const [key, title] of Object.entries(COLUMNS)) {
    col[key] = header.indexOf(title);
    if (col[key] < 0) throw new Error(`'${title}' 열을 찾을 수 없습니다.`);
  }

  const first = header.indexOf(FIRST_REGISTERED);
  const people = [];
  for (const row of values.slice(1)) {
    const code = String(row[col.member_code]).trim();
    const name = String(row[col.name]).trim();
    if (!code || !name) continue;
    people.push({
      member_code: code,
      family_code: String(row[col.family_code]).trim() || null,
      name: name,
      relation: String(row[col.relation]).trim() || null,
      registered_on: (first >= 0 && toDate(row[first])) || toDate(row[col.registered_at]),
    });
  }

  const headers = { Authorization: `Bearer ${token}` };
  const id = props.getProperty('CF_ACCESS_CLIENT_ID');
  const secret = props.getProperty('CF_ACCESS_CLIENT_SECRET');
  if (id && secret) {
    headers['CF-Access-Client-Id'] = id;
    headers['CF-Access-Client-Secret'] = secret;
  }

  const total = { created: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < people.length; i += CHUNK) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify({ people: people.slice(i, i + CHUNK) }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error(`교적부 연동 실패 (${res.getResponseCode()}): ${res.getContentText().slice(0, 300)}`);
    }
    const r = JSON.parse(res.getContentText());
    total.created += r.created;
    total.updated += r.updated;
    total.unchanged += r.unchanged;
  }
  return total;
}

/** '2026-08-09 14:30:51' or a Date cell -> '2026-08-09' (Hobart calendar), else null. */
function toDate(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, 'Australia/Hobart', 'yyyy-MM-dd');
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
  return m ? m[1] : null;
}
