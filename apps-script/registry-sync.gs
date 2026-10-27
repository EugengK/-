/**
 * 목양 나눔 기록 → 교적부 연동 (Google Apps Script)
 *
 * 이 스크립트는 '교인목록' 탭에서 아래 칸만 골라 회계 서버의 교적부로 보냅니다:
 *   교인ID, 가정ID, 이름, 관계, 생년월일, 직분, 등록일 (최초등록일, 없으면 등록일시의 날짜)
 *   직분은 처음 등록할 때만 쓰이고, 그 뒤 직분 변경은 교적부에서 합니다.
 * 상담 내용, 신앙 상태, 기도제목, 주소 등 다른 칸은 보내지 않습니다. (시트를 읽을 때 메모리에는
 * 함께 올라오지만, 위 일곱 칸만 골라 보냅니다.)
 *
 * 주의: 이 스크립트의 속성(토큰)은 이 시트의 '편집' 권한이 있는 사람이면 볼 수 있습니다.
 * 시트 편집 권한은 목사님만 가지시고, 공유 범위가 바뀌면 서버의 SYNC_TOKEN 을 새로 바꾸세요.
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
// Optional columns: used when present.
const BIRTH = '생년월일';
const TITLE = '직분';
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
  // If another run is still going, wait for it: the next run then sends the latest sheet.
  if (!lock.tryLock(120000)) return;
  try {
    sendToRegistry();
  } finally {
    lock.releaseLock();
  }
}

function sendToRegistryWithAlert() {
  const r = sendToRegistry();
  let msg = `교적부 연동 완료\n새로 등록: ${r.created}명, 변경: ${r.updated}명, 그대로: ${r.unchanged}명`;
  if (r.pending) msg += `\n확인 필요: ${r.pending}명 (회계 프로그램 교적부 화면에서 '같은 분/새로 등록'을 골라 주세요)`;
  if (r.skipped.length) msg += `\n\n보내지 못한 줄 (시트에서 고쳐 주세요):\n${r.skipped.join('\n')}`;
  if (r.notes.length) msg += `\n\n참고:\n${r.notes.join('\n')}`;
  if (r.unknownTitles.length) msg += `\n\n목록에 없는 직분이라 기록하지 않음: ${r.unknownTitles.join(', ')}`;
  SpreadsheetApp.getUi().alert(msg);
}

/** Reads the seven allowed columns and sends them. Returns totals. */
function sendToRegistry() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('REGISTRY_URL');
  const token = props.getProperty('REGISTRY_TOKEN');
  if (!url || !token) throw new Error('스크립트 속성 REGISTRY_URL / REGISTRY_TOKEN 이 없습니다.');
  if (!/^https:\/\//.test(url)) throw new Error('REGISTRY_URL 은 https:// 로 시작해야 합니다. (토큰이 암호화 없이 전송되지 않도록)');

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
  const birthCol = header.indexOf(BIRTH);
  const titleCol = header.indexOf(TITLE);
  const today = Utilities.formatDate(new Date(), 'Australia/Hobart', 'yyyy-MM-dd');
  const people = [];
  const skipped = [];
  const notes = [];
  const seen = new Set();
  values.slice(1).forEach((row, i) => {
    const code = String(row[col.member_code]).trim();
    const name = String(row[col.name]).trim();
    if (!code && !name) return; // empty row
    // Same rules as the server. One bad row is reported and skipped instead of stopping every sync.
    const family = String(row[col.family_code]).trim();
    const relation = String(row[col.relation]).trim();
    const problem =
      !/^[A-Za-z0-9-]{3,40}$/.test(code) ? '교인ID 형식' :
      family && !/^[A-Za-z0-9-]{3,40}$/.test(family) ? '가정ID 형식' :
      !name || name.length > 50 ? '이름' :
      relation.length > 20 ? '관계' : '';
    const title = titleCol >= 0 ? String(row[titleCol]).trim() : '';
    let birth = birthCol >= 0 ? toDate(row[birthCol]) : null;
    if (birth && (birth < '1900-01-01' || birth > today)) birth = null;
    if (birthCol >= 0 && !birth && String(row[birthCol]).trim()) notes.push(`${i + 2}행 생년월일을 읽지 못함`);
    let reg = (first >= 0 && toDate(row[first])) || toDate(row[col.registered_at]);
    if (reg && (reg < '1900-01-01' || reg > today)) reg = null; // the server refuses impossible dates
    if (problem) {
      skipped.push(`${i + 2}행 (${problem})`);
      return;
    }
    if (seen.has(code)) {
      skipped.push(`${i + 2}행 (교인ID가 다른 줄과 같음)`);
      return;
    }
    seen.add(code);
    people.push({
      member_code: code,
      family_code: family || null,
      name: name,
      relation: relation || null,
      registered_on: reg,
      birth_date: birth,
      title: title && title.length <= 20 ? title : null,
    });
  });

  const headers = { Authorization: `Bearer ${token}` };
  const id = props.getProperty('CF_ACCESS_CLIENT_ID');
  const secret = props.getProperty('CF_ACCESS_CLIENT_SECRET');
  if (id && secret) {
    headers['CF-Access-Client-Id'] = id;
    headers['CF-Access-Client-Secret'] = secret;
  }

  const total = { created: 0, updated: 0, pending: 0, unchanged: 0, skipped: skipped, notes: notes, unknownTitles: [] };
  for (let i = 0; i < people.length; i += CHUNK) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify({ people: people.slice(i, i + CHUNK) }),
      muteHttpExceptions: true,
      followRedirects: false, // never hand the token to a redirect target
    });
    if (res.getResponseCode() !== 200) {
      throw new Error(`교적부 연동 실패 (${res.getResponseCode()}): ${res.getContentText().slice(0, 300)}`);
    }
    const r = JSON.parse(res.getContentText());
    total.created += r.created;
    total.updated += r.updated;
    total.pending += r.pending || 0;
    total.unchanged += r.unchanged;
    (r.unknown_titles || []).forEach((t) => { if (total.unknownTitles.indexOf(t) < 0) total.unknownTitles.push(t); });
  }
  return total;
}

/**
 * '2026-08-09 14:30:51', '1960. 5. 1', '1960/05/01' or a Date cell -> 'YYYY-MM-DD' (Hobart calendar).
 * Impossible dates (e.g. 2026-13-45, 1960-02-30) -> null, so one bad cell can't fail the whole send.
 */
function toDate(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, 'Australia/Hobart', 'yyyy-MM-dd');
  const m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/.exec(String(v).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
