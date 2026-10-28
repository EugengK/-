// 교회 회계 — screens. Plain JS, no build step.
// All text from the server is inserted with textContent (via h()), never innerHTML.

const state = { me: null, settings: {}, funds: [], members: [] };
const view = document.getElementById("view");

// ---------- helpers ----------

/** h("div", {class: "x", onclick: fn}, "text", child) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const moneyFmt = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const money = (cents) => moneyFmt.format(cents / 100);

/**
 * "1,234.5" / "$20" -> cents. Exact (no floating point). Returns null if not a valid amount.
 * Commas are only accepted as thousands separators, so "20,50" is rejected rather than read as 2050.
 */
function toCents(text, { allowNegative = false } = {}) {
  // Spaces/$ only around the number; "20 50" is rejected rather than read as 2050.
  const s = String(text).trim().replace(/^\$\s*/, "").replace(/^-\s*\$\s*/, "-");
  const m = /^(-)?(\d{1,3}(?:,\d{3})+|\d{1,10})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m || (m[1] && !allowNegative)) return null;
  const cents = Number(m[2].replace(/,/g, "")) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Today in Hobart (the church's calendar), whatever time zone the phone is set to. */
const hobartToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Hobart" }).format(new Date());
/** Calendar arithmetic on "YYYY-MM-DD" without time zones. */
const dateAdd = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);
function lastSunday() {
  const t = hobartToday();
  return dateAdd(t, -new Date(`${t}T00:00:00Z`).getUTCDay());
}
function monthRange() {
  const t = hobartToday();
  const last = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7), 0)).getUTCDate();
  return { from: `${t.slice(0, 8)}01`, to: `${t.slice(0, 8)}${pad(last)}` };
}
/** Strict real-date check (rejects 1960-02-30, which Date.parse accepts). */
function isRealYmd(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = isError ? "toast error" : "toast";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2500);
}

async function api(method, path, body) {
  const init = { method, headers: {} };
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  // Never leave the screen stuck on "불러오는 중…" if the server stops answering.
  init.signal = AbortSignal.timeout(20000);
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    const write = method !== "GET" ? " 저장 중이었다면 저장되었을 수도 있으니, 내역에서 먼저 확인한 뒤 다시 시도하세요." : "";
    throw new Error((err?.name === "TimeoutError" ? "서버가 응답하지 않습니다." : "서버에 연결할 수 없습니다.") + write);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  // Server messages may start with a field path ("reason: ", "entries.0.amount_cents: "): not useful here.
  if (!res.ok) throw new Error((data?.error ?? `오류가 발생했습니다 (${res.status})`).replace(/^[A-Za-z_][\w.]*: /, ""));
  return data;
}

/**
 * In-page confirm/prompt. The browser's own confirm()/prompt() can be silently switched off
 * ("prevent this page from creating additional dialogs"), which would make buttons do nothing.
 * Resolves to true/false, or — with `input` — to the typed text / null when cancelled.
 */
function ask(message, { input, okText = "확인", cancelText = "취소", required = false } = {}) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const dlg = h("dialog", { class: "ask" });
    const field = input !== undefined ? h("input", { value: input ?? "", maxlength: 300, "aria-label": "입력" }) : null;
    const hint = h("p", { class: "muted", hidden: true }, "내용을 입력하세요.");
    const done = (v) => { dlg.close(); dlg.remove(); opener?.focus?.(); resolve(v); };
    const ok = h("button", { type: "button", onclick: () => {
      if (field && required && !field.value.trim()) { hint.hidden = false; field.focus(); return; }
      done(field ? field.value : true);
    } }, okText);
    const cancel = h("button", { type: "button", class: "secondary", onclick: () => done(field ? null : false) }, cancelText);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(field ? null : false); });
    field?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) ok.click(); });
    dlg.append(h("p", { class: "ask-msg" }, message), field ?? "", hint, h("div", { class: "row mt" }, cancel, ok));
    document.body.append(dlg);
    dlg.showModal();
    (field ?? ok).focus();
  });
}

/** Runs an async action, reporting errors; disables the button while it runs. */
async function act(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

const isEditor = () => state.me?.role === "editor";

function currentTab() {
  const t = location.hash.slice(1).split("/")[0];
  return t in routes ? t : isEditor() ? "entry" : "offerings";
}
/**
 * Every screen render takes a ticket; only the newest one may draw. A slow, older render (e.g. the
 * refresh after a save) then can't overwrite a screen the user has since opened or started typing in.
 */
let renderTicket = 0;
const newTicket = () => ++renderTicket;
function paint(ticket, ...children) {
  if (ticket === renderTicket) view.replaceChildren(...children);
}
const methodTag = (m) => h("span", { class: `tag ${m}` }, m === "cash" ? "현금" : "온라인");

async function loadFunds() {
  state.funds = await api("GET", "/api/fund-types");
}
async function loadMembers() {
  const all = await api("GET", "/api/members?include_inactive=1");
  state.members = all.filter((m) => m.is_active);
  state.departed = all.filter((m) => !m.is_active);
}
/**
 * Unique text for each member in the giver list. When two people share a name, every one of them
 * gets a distinguishing label (note, or #id), so typing the bare name is never silently one of them.
 */
function memberChoices() {
  const byName = new Map();
  for (const m of state.members) byName.set(m.name, (byName.get(m.name) ?? 0) + 1);
  const raw = state.members.map((m) => ({
    id: m.id,
    name: m.name,
    // Same name: show what tells them apart (title, birth year, note, relation), id only as a last resort.
    label: byName.get(m.name) > 1
      ? `${m.name} (${[m.current_title, m.birth_date ? `${m.birth_date.slice(0, 4)}년생` : null, m.note, m.relation].filter(Boolean).join(", ") || `#${m.id}`})`
      : m.name,
  }));
  const byLabel = new Map();
  for (const c of raw) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + 1);
  return raw.map((c) => (byLabel.get(c.label) > 1 ? { ...c, label: `${c.label} #${c.id}` } : c));
}

/** Typed giver text -> { id } (id null = blank) or { error }. Accepts a list choice or a unique bare name. */
function resolveGiver(text, choices) {
  const t = text.normalize("NFC").trim();
  if (!t) return { id: null };
  const exact = choices.find((c) => c.label === t);
  if (exact) return { id: exact.id };
  const sameName = choices.filter((c) => c.name === t);
  if (sameName.length === 1) return { id: sameName[0].id };
  if (sameName.length > 1) return { error: `'${t}' 이름이 ${sameName.length}명 있습니다. 목록에서 정확히 골라 주세요.` };
  if ((state.departed ?? []).some((m) => m.name === t)) {
    return { error: `'${t}'은(는) 교적부에 떠남·이명·별세로 기록된 분입니다. 다시 출석하시면 목사님께 '복귀' 기록을 요청하세요.` };
  }
  return { error: `'${t}'은(는) 성도 명부에 없습니다. 목록에서 고르거나, 목사님께 교적부 등록을 요청하세요.` };
}

// ---------- 헌금 입력 ----------

function lineEditor(onChange, choices) {
  const line = { method: "cash" };
  const fund = h(
    "select",
    { "aria-label": "헌금 종류", onchange: onChange },
    state.funds.map((f) => h("option", { value: f.id }, f.name)),
  );
  const amount = h("input", { inputmode: "decimal", placeholder: "0.00", "aria-label": "금액", oninput: onChange });
  // Type a few letters and pick from the list; left blank = anonymous (confirmed on save).
  const member = h("input", { list: "giver-list", placeholder: "이름 입력 (비우면 무기명)", "aria-label": "성도", autocomplete: "off" });
  const note = h("input", { placeholder: "메모 (선택)", "aria-label": "메모", maxlength: 300 });
  const cashBtn = h("button", { type: "button", class: "on" }, "현금");
  const onlineBtn = h("button", { type: "button" }, "온라인");
  const setMethod = (m) => {
    line.method = m;
    cashBtn.classList.toggle("on", m === "cash");
    onlineBtn.classList.toggle("on", m === "online");
    onChange();
  };
  cashBtn.onclick = () => setMethod("cash");
  onlineBtn.onclick = () => setMethod("online");

  const removeBtn = h("button", { type: "button", class: "danger small" }, "삭제");
  const el = h(
    "div",
    { class: "line" },
    h("div", { class: "head" }, h("span", {}, "헌금"), removeBtn),
    h(
      "div",
      { class: "grid" },
      h("div", { class: "row" }, h("div", {}, h("label", {}, "종류"), fund), h("div", {}, h("label", {}, "금액 ($)"), amount)),
      h("div", { class: "row" }, h("div", {}, h("label", {}, "방식"), h("div", { class: "seg" }, cashBtn, onlineBtn)), h("div", {}, h("label", {}, "성도"), member)),
      note,
    ),
  );
  Object.assign(line, {
    el,
    removeBtn,
    focus: () => amount.focus(),
    cents: () => toCents(amount.value),
    isBlank: () => amount.value.trim() === "",
    giver: () => resolveGiver(member.value, choices),
    focusGiver: () => member.focus(),
    value: () => ({
      fund_type_id: Number(fund.value),
      amount_cents: toCents(amount.value),
      method: line.method,
      member_id: resolveGiver(member.value, choices).id ?? null,
      note: note.value.trim() || undefined,
    }),
  });
  return line;
}

/** keepDate: after a save, stay on the same date so a second batch for that day isn't misdated. */
async function renderEntry(keepDate) {
  const ticket = newTicket();
  if (!isEditor()) {
    paint(ticket, h("h2", {}, "헌금 입력"), h("p", { class: "notice" }, "열람 권한으로 로그인되어 있어 입력할 수 없습니다. '헌금 내역'에서 확인하세요."));
    return;
  }
  await Promise.all([loadFunds(), loadMembers()]);
  if (!state.funds.length) {
    paint(ticket, h("h2", {}, "헌금 입력"), h("p", { class: "notice" }, "설정에서 헌금 종류를 먼저 추가하세요."));
    return;
  }
  const lines = [];
  const date = h("input", { type: "date", value: keepDate || lastSunday(), "aria-label": "날짜" });
  // Same key on every retry of this form, so a resend after a dropped connection is not saved twice.
  // Same key for resends of the same form (a resend after a dropped reply is recognised and not saved
  // twice); a new key as soon as the form differs from what was last sent.
  let clientKey = crypto.randomUUID();
  let sentSig = null;
  const list = h("div");
  const totalCash = h("b", {}, money(0));
  const totalOnline = h("b", {}, money(0));
  const totalAll = h("b", {}, money(0));
  const recalc = () => {
    let cash = 0, online = 0;
    for (const l of lines) {
      const c = l.cents();
      if (c === null) continue;
      if (l.method === "cash") cash += c; else online += c;
    }
    totalCash.textContent = money(cash);
    totalOnline.textContent = money(online);
    totalAll.textContent = money(cash + online);
  };
  const choices = memberChoices();
  const giverList = h("datalist", { id: "giver-list" }, choices.map((c) => h("option", { value: c.label })));
  const addLine = () => {
    const l = lineEditor(recalc, choices);
    l.removeBtn.onclick = () => {
      if (lines.length === 1) return;
      lines.splice(lines.indexOf(l), 1);
      l.el.remove();
      recalc();
    };
    lines.push(l);
    list.append(l.el);
    return l;
  };
  addLine();

  const save = h("button", { type: "button" }, "저장");
  save.onclick = () =>
    act(save, async () => {
      const filled = lines.filter((l) => !l.isBlank());
      if (!filled.length) throw new Error("금액을 입력하세요.");
      const bad = lines.findIndex((l) => !l.isBlank() && (l.cents() === null || l.cents() <= 0));
      if (bad >= 0) throw new Error(`${bad + 1}번째 줄 금액이 올바르지 않습니다. (예: 20, 20.50, 1,200)`);
      const anonymous = [];
      for (const [i, l] of lines.entries()) {
        if (l.isBlank()) continue;
        const g = l.giver();
        if (g.error) {
          l.focusGiver();
          throw new Error(`${i + 1}번째 줄: ${g.error}`);
        }
        if (g.id === null) anonymous.push(i);
      }
      // One dialog: the totals, plus a clear warning line when some lines have no giver.
      const entries = filled.map((l) => l.value());
      const total = entries.reduce((s, e) => s + e.amount_cents, 0);
      const warn = anonymous.length
        ? `⚠️ ${anonymous.map((i) => `${i + 1}번째`).join(", ")} 줄은 성도 이름이 없어 무기명으로 저장됩니다.\n(이름을 넣으려면 '취소')\n\n`
        : "";
      if (!(await ask(`${warn}${date.value} 헌금 ${entries.length}건, 합계 ${money(total)}을 저장할까요?`, { okText: "저장" }))) {
        if (anonymous.length) lines[anonymous[0]].focusGiver();
        return;
      }
      const sig = JSON.stringify([date.value, entries]);
      if (sentSig !== null && sentSig !== sig) clientKey = crypto.randomUUID();
      sentSig = sig;
      const saved = await api("POST", "/api/offerings", { offering_date: date.value, entries, client_key: clientKey });
      // Report what the server holds, not what the form says.
      const savedTotal = saved.reduce((n, o) => n + o.amount_cents, 0);
      if (saved.length !== entries.length || savedTotal !== total) {
        await ask(`이 입력은 앞서 저장된 내용으로 이미 처리되어 있었습니다.\n저장된 것: ${saved.length}건, ${money(savedTotal)}\n'헌금 내역'에서 확인하고, 필요하면 바로잡으세요.`, { okText: "확인", cancelText: "닫기" });
      }
      toast(`${saved[0]?.offering_date ?? date.value} 헌금 저장: ${saved.length}건, ${money(savedTotal)}`);
      renderEntry(date.value);
    });

  paint(ticket, 
    h("h2", {}, "헌금 입력"),
    giverList,
    h("div", { class: "card" }, h("label", {}, "날짜"), date),
    list,
    h("button", { type: "button", class: "secondary", onclick: () => addLine().focus() }, "+ 줄 추가"),
    h(
      "div",
      { class: "card mt" },
      h("div", { class: "totals" },
        h("div", { class: "stat" }, totalCash, h("span", {}, "현금")),
        h("div", { class: "stat" }, totalOnline, h("span", {}, "온라인")),
        h("div", { class: "stat" }, totalAll, h("span", {}, "합계"))),
      h("div", { class: "mt" }, save),
    ),
  );
  lines[0].focus();
}

// ---------- 헌금 내역 ----------

async function renderOfferings() {
  const ticket = newTicket();
  // Include stopped types so old offerings recorded under them can still be filtered.
  const allFunds = await api("GET", "/api/fund-types?include_inactive=1");
  const r = monthRange();
  const from = h("input", { type: "date", value: r.from, "aria-label": "시작일" });
  const to = h("input", { type: "date", value: r.to, "aria-label": "종료일" });
  const fund = h("select", { "aria-label": "헌금 종류" }, h("option", { value: "" }, "전체 종류"), allFunds.map((f) => h("option", { value: f.id }, f.is_active ? f.name : `${f.name} (사용 중지)`)));
  const showVoid = h("input", { type: "checkbox", style: "width:auto;min-height:0" });
  const out = h("div");

  // Each change starts a new load; an older, slower response must not overwrite a newer one.
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    if (from.value && to.value && from.value > to.value) {
      out.replaceChildren(h("p", { class: "notice" }, "시작일이 종료일보다 늦습니다. 날짜를 확인하세요."));
      return;
    }
    const q = new URLSearchParams({ from: from.value, to: to.value });
    if (fund.value) q.set("fund_type_id", fund.value);
    const [sum, rows] = await Promise.all([
      api("GET", `/api/offerings/summary?${q}`),
      api("GET", `/api/offerings?${q}${showVoid.checked ? "&include_void=1" : ""}`),
    ]);
    if (mine !== seq) return;
    const byFund = new Map();
    for (const s of sum.rows) {
      const e = byFund.get(s.fund_type_id) ?? { name: s.fund_type_name, cash: 0, online: 0 };
      e[s.method] += s.total_cents;
      byFund.set(s.fund_type_id, e);
    }
    out.replaceChildren(...[
      h("div", { class: "card" },
        h("div", { class: "totals" },
          h("div", { class: "stat" }, h("b", {}, money(sum.cash_cents)), h("span", {}, "현금")),
          h("div", { class: "stat" }, h("b", {}, money(sum.online_cents)), h("span", {}, "온라인")),
          h("div", { class: "stat" }, h("b", {}, money(sum.total_cents)), h("span", {}, "합계"))),
        byFund.size
          ? h("table", { class: "mt" },
              h("thead", {}, h("tr", {}, h("th", {}, "종류"), h("th", { class: "num" }, "현금"), h("th", { class: "num" }, "온라인"), h("th", { class: "num" }, "합계"))),
              h("tbody", {}, [...byFund.values()].map((e) =>
                h("tr", {}, h("td", {}, e.name), h("td", { class: "num" }, money(e.cash)), h("td", { class: "num" }, money(e.online)), h("td", { class: "num" }, money(e.cash + e.online))))))
          : h("p", { class: "muted" }, "이 기간에 헌금 기록이 없습니다.")),
      rows.length
        ? h("div", { class: "card" },
            h("h3", {}, `상세 (${rows.length}건)`),
            rows.length >= 1000 ? h("p", { class: "notice" }, "상세 목록은 최근 1000건까지만 보입니다. 기간을 줄여 보세요. (위 합계는 전체 기준입니다.)") : null,
            h("table", {},
              h("tbody", {}, rows.map((o) =>
                h("tr", { class: o.status === "void" ? "void-row" : "" },
                  h("td", {}, o.offering_date, h("br"), h("span", { class: "muted" }, o.fund_type_name)),
                  h("td", {}, o.member_name ?? "(무기명)", " ", methodTag(o.method),
                    o.note ? h("div", { class: "muted" }, o.note) : null,
                    o.status === "void" ? h("div", {}, h("span", { class: "tag void" }, "취소됨"), " ", o.void_reason) : null),
                  h("td", { class: "num" }, money(o.amount_cents),
                    o.status === "active"
                      ? h("div", { class: "editor-only" }, h("button", { type: "button", class: "danger small", onclick: (e) => voidOffering(e.currentTarget, o, load) }, "취소"))
                      : null)))))
          )
        : null,
    ].filter(Boolean));
  };
  const reload = () => act(null, load);
  for (const el of [from, to, fund, showVoid]) el.addEventListener("change", reload);

  paint(ticket, 
    h("h2", {}, "헌금 내역"),
    h("div", { class: "card" },
      h("div", { class: "row" }, h("div", {}, h("label", {}, "시작일"), from), h("div", {}, h("label", {}, "종료일"), to)),
      h("div", { class: "row mt" }, h("div", {}, h("label", {}, "종류"), fund),
        h("label", { class: "shrink", style: "display:flex;gap:6px;align-items:center;margin:0" }, showVoid, "취소된 항목 보기"))),
    out,
  );
  await reload();
}

async function voidOffering(btn, o, after) {
  const reason = await ask(`${o.offering_date} ${o.fund_type_name} ${money(o.amount_cents)}\n이 항목을 취소합니다. 취소 사유를 입력하세요.\n(잘못 입력했다면 취소 후 다시 입력하세요.)`, { input: "", okText: "취소 처리", cancelText: "닫기", required: true });
  if (reason === null) return;
  act(btn, async () => {
    await api("POST", `/api/offerings/${o.id}/void`, { reason });
    toast("취소했습니다.");
    await after();
  });
}

// ---------- 지출 ----------

const accountTag = (a) => h("span", { class: `tag ${a === "cash" ? "cash" : "online"}` }, a === "cash" ? "현금" : "은행");
const EXPENSE_STATUS = { planned: "예정", confirmed: "지급", draft: "확인 전", void: "취소됨" };
const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

/** Marks a planned fixed cost as paid: actual amount (prefilled) and the day it was actually paid. */
function payPlanned(btn, e, after) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "ask" });
    const amount = h("input", { inputmode: "decimal", value: (e.total_cents / 100).toFixed(2), "aria-label": "지급 금액" });
    const date = h("input", { type: "date", value: hobartToday(), max: hobartToday(), "aria-label": "지급한 날" });
    const close = () => { dlg.close(); dlg.remove(); resolve(); };
    dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
    const ok = h("button", { type: "button" }, "지급 완료");
    ok.onclick = () =>
      act(ok, async () => {
        const cents = toCents(amount.value);
        if (cents === null || cents <= 0) throw new Error("금액이 올바르지 않습니다.");
        if (!isRealYmd(date.value)) throw new Error("지급한 날을 고르세요.");
        await api("POST", `/api/expenses/${e.id}/pay`, { total_cents: cents, expense_date: date.value });
        toast(`지급 완료: ${e.recurring_name ?? e.vendor} ${money(cents)}`);
        close();
        await after();
      });
    const form = h("form", { method: "dialog", onsubmit: (ev) => { ev.preventDefault(); ok.click(); } },
      h("h3", {}, e.recurring_name ?? e.vendor),
      h("p", { class: "muted" }, `예정일 ${e.expense_date}${e.note ? ` · ${e.note}` : ""}`),
      h("div", { class: "row" }, h("div", {}, h("label", {}, "지급 금액 ($)"), amount), h("div", {}, h("label", {}, "지급한 날"), date)),
      h("div", { class: "row mt" }, h("button", { type: "button", class: "secondary", onclick: close }, "닫기"), ok));
    dlg.append(form);
    document.body.append(dlg);
    dlg.showModal();
    amount.focus();
  });
}

async function voidExpense(btn, e, after) {
  const planned = e.status === "planned";
  const reason = await ask(`${e.expense_date} ${e.recurring_name ?? e.vendor} ${money(e.total_cents)}\n${planned ? "이번 회차를 건너뜁니다." : "이 지출을 취소합니다."} 사유를 입력하세요.`, {
    input: "", okText: planned ? "건너뛰기" : "취소 처리", cancelText: "닫기", required: true,
  });
  if (reason === null) return;
  await act(btn, async () => {
    await api("POST", `/api/expenses/${e.id}/void`, { reason });
    toast(planned ? "건너뛰었습니다." : "취소했습니다.");
    await after();
  });
}

/** Re-draws the 지출 tab if it is the one on screen (after something changed elsewhere). */
const refreshExpensesTab = () => { if (currentTab() === "expenses") renderExpenses(); };

/** Opens once a day for finance editors: fixed costs due this week (and any overdue). */
async function remindDue() {
  if (!isEditor()) return;
  let due;
  try { due = await api("GET", "/api/expenses/due"); } catch { return; }
  refreshExpensesTab(); // the call above may have just added this week's planned rows
  if (!due.items.length) return;
  const key = `due-reminder-${new Date().toDateString()}`;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch { /* storage blocked: just remind */ }

  const dlg = h("dialog", { class: "ask" });
  const close = () => { dlg.close(); dlg.remove(); refreshExpensesTab(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  const list = h("ul", { class: "list" });
  // Pay/skip open their own dialog, so this one steps aside and comes back with what is left.
  const handle = async (action, btn, e) => {
    dlg.close();
    await action(btn, e, async () => {});
    try {
      const fresh = await api("GET", "/api/expenses/due");
      if (!fresh.items.length) return close();
      fill(fresh.items);
      dlg.showModal();
    } catch (err) {
      toast(err.message, true);
      close();
    }
  };
  const fill = (items) =>
    list.replaceChildren(...items.map((e) =>
      h("li", { style: "flex-wrap:wrap" },
        h("div", { class: "grow" },
          h("b", {}, e.recurring_name ?? e.vendor), " ", accountTag(e.account),
          h("div", { class: e.overdue ? "" : "muted", style: e.overdue ? "color:var(--danger)" : "" },
            `${e.expense_date}${e.overdue ? " · 날짜 지남" : ""} · ${money(e.total_cents)}`)),
        h("span", { class: "row shrink" },
          h("button", { type: "button", class: "mini danger-text", onclick: (ev) => handle(voidExpense, ev.currentTarget, e) }, "건너뛰기"),
          h("button", { type: "button", class: "small", onclick: (ev) => handle(payPlanned, ev.currentTarget, e) }, "지급 완료")))));
  fill(due.items);
  dlg.append(
    h("h3", {}, "이번 주 고정 지출"),
    h("p", { class: "muted" }, "지급했으면 '지급 완료'를 누르세요. 자동이체도 실제로 나갔는지 확인한 뒤 누르시면 됩니다. 이번에는 내지 않는 경우 '건너뛰기'를 누르세요."),
    list,
    h("div", { class: "row mt" }, h("button", { type: "button", class: "secondary", onclick: () => { close(); location.hash = "#expenses"; } }, "지출 탭에서 보기"), h("button", { type: "button", onclick: close }, "나중에")),
  );
  document.body.append(dlg);
  dlg.showModal();
}

async function renderExpenses() {
  const ticket = newTicket();
  const view = location.hash.split("/")[1] || "list"; // list | new | fixed
  const [depts, cats] = await Promise.all([api("GET", "/api/departments"), api("GET", "/api/expense-categories")]);
  const seg = h("div", { class: "seg mt", role: "tablist" },
    ...[["list", "지출 내역"], ["new", "지출 입력"], ["fixed", "고정 지출"]]
      .filter(([k]) => k === "list" || isEditor())
      .map(([k, label]) => h("button", { type: "button", class: view === k ? "on" : "", onclick: () => { location.hash = `#expenses/${k}`; } }, label)));
  const body =
    view === "new" && isEditor() ? expenseEntryCard(depts, cats) :
    view === "fixed" ? recurringCard(depts, cats, async () => {}) :
    await expenseListView(depts, cats);
  paint(ticket, h("h2", {}, "지출"), seg, h("div", { class: "mt" }, body));
}

/** 지출 내역: period, totals (paid vs planned kept apart), list with edit / pay / cancel. */
async function expenseListView(depts, cats) {
  const r = monthRange();
  const from = h("input", { type: "date", value: r.from, "aria-label": "시작일" });
  const to = h("input", { type: "date", value: r.to, "aria-label": "종료일" });
  const deptSel = h("select", { "aria-label": "부서" }, h("option", { value: "" }, "전체 부서"), depts.map((x) => h("option", { value: x.id }, x.name)));
  const out = h("div");
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    if (from.value > to.value) { out.replaceChildren(h("p", { class: "notice" }, "시작일이 종료일보다 늦습니다.")); return; }
    const q = new URLSearchParams({ from: from.value, to: to.value });
    if (deptSel.value) q.set("department_id", deptSel.value); // filters the totals as well as the list
    const [sum, rows] = await Promise.all([api("GET", `/api/expenses/summary?${q}`), api("GET", `/api/expenses?${q}`)]);
    if (mine !== seq) return;
    out.replaceChildren(
      h("div", { class: "card" },
        h("div", { class: "totals" },
          h("div", { class: "stat" }, h("b", {}, money(sum.paid_cash_cents)), h("span", {}, "지급 (현금)")),
          h("div", { class: "stat" }, h("b", {}, money(sum.paid_bank_cents)), h("span", {}, "지급 (은행)")),
          h("div", { class: "stat planned" }, h("b", {}, money(sum.planned_cents)), h("span", {}, "예정 (아직 안 나감)")))),
      h("div", { class: "card" },
        h("h3", {}, `지출 내역 (${rows.length}건)`),
        rows.length
          ? h("table", {}, h("tbody", {}, rows.map((e) =>
              h("tr", { class: e.status === "planned" ? "planned-row" : "" },
                h("td", {}, e.expense_date, h("br"), h("span", { class: `tag ${e.status === "planned" ? "planned" : ""}` }, EXPENSE_STATUS[e.status])),
                h("td", {}, e.recurring_name ? h("b", {}, e.recurring_name) : e.vendor, " ", accountTag(e.account),
                  e.recurring_name && e.vendor !== e.recurring_name ? h("div", { class: "muted" }, e.vendor) : null,
                  [e.department_name, e.category_name].some(Boolean) ? h("div", { class: "muted" }, [e.department_name, e.category_name].filter(Boolean).join(" · ")) : null,
                  e.note ? h("div", { class: "muted" }, e.note) : null),
                h("td", { class: "num" }, money(e.total_cents),
                  h("div", { class: "editor-only actions" },
                    e.status === "planned" ? h("button", { type: "button", class: "small", onclick: (ev) => payPlanned(ev.currentTarget, e, load) }, "지급") : null,
                    h("button", { type: "button", class: "mini", onclick: (ev) => editExpense(ev.currentTarget, e, depts, cats, load) }, "수정"),
                    h("button", { type: "button", class: "mini danger-text", onclick: (ev) => voidExpense(ev.currentTarget, e, load) }, e.status === "planned" ? "건너뛰기" : "취소")))))))
          : h("p", { class: "muted" }, "이 기간에 지출이 없습니다.")),
    );
  };
  for (const el of [from, to, deptSel]) el.addEventListener("change", () => act(null, load));
  const wrap = h("div",
    {},
    h("div", { class: "card" },
      h("div", { class: "row" }, h("div", {}, h("label", {}, "시작일"), from), h("div", {}, h("label", {}, "종료일"), to)),
      depts.length ? h("div", { class: "mt" }, deptSel) : null),
    out);
  await act(null, load);
  return wrap;
}

/** Edit dialog for an expense (only changed fields are sent). */
async function editExpense(btn, e, depts, cats, after) {
  const dlg = h("dialog", { class: "ask" });
  const date = h("input", { type: "date", value: e.expense_date, "aria-label": "날짜" });
  const vendor = h("input", { value: e.vendor, maxlength: 100, "aria-label": "지급처 / 내용" });
  const amount = h("input", { inputmode: "decimal", value: (e.total_cents / 100).toFixed(2), "aria-label": "금액" });
  const account = h("select", { "aria-label": "계정" }, h("option", { value: "cash" }, "현금"), h("option", { value: "bank" }, "은행"));
  account.value = e.account;
  const sel = (label, rows, cur) => {
    const s = h("select", { "aria-label": label }, h("option", { value: "" }, `${label} 없음`), rows.map((x) => h("option", { value: x.id }, x.name)));
    s.value = cur == null ? "" : String(cur);
    return s;
  };
  const dept = sel("부서", depts, e.department_id), cat = sel("지출 항목", cats, e.category_id);
  const note = h("input", { value: e.note ?? "", maxlength: 300, "aria-label": "메모" });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
  dlg.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.isComposing && ev.target.tagName === "INPUT") save.click(); });
  const save = h("button", { type: "button" }, "저장");
  save.onclick = () =>
    act(save, async () => {
      const cents = toCents(amount.value);
      if (cents === null || cents <= 0) throw new Error("금액이 올바르지 않습니다.");
      const body = {};
      if (date.value !== e.expense_date) body.expense_date = date.value;
      if (vendor.value.trim() !== e.vendor) body.vendor = vendor.value;
      if (cents !== e.total_cents) body.total_cents = cents;
      if (account.value !== e.account) body.account = account.value;
      const d = dept.value ? Number(dept.value) : null, c = cat.value ? Number(cat.value) : null;
      if (d !== e.department_id) body.department_id = d;
      if (c !== e.category_id) body.category_id = c;
      if (note.value.trim() !== (e.note ?? "")) body.note = note.value;
      if (!Object.keys(body).length) return close();
      await api("PATCH", `/api/expenses/${e.id}`, body);
      close();
      toast("지출을 고쳤습니다.");
      await after();
    });
  dlg.append(
    h("h3", {}, "지출 수정"),
    h("div", { class: "grid" },
      h("div", { class: "row" }, h("div", {}, h("label", {}, "날짜"), date), h("div", {}, h("label", {}, "금액 ($)"), amount)),
      h("div", {}, h("label", {}, "지급처 / 내용"), vendor),
      h("div", { class: "row" }, h("div", {}, h("label", {}, "계정"), account), h("div", {}, h("label", {}, "부서"), dept)),
      h("div", { class: "row" }, h("div", {}, h("label", {}, "지출 항목"), cat)),
      h("div", {}, h("label", {}, "메모"), note)),
    h("p", { class: "muted mt" }, "고친 내용은 '기록' 탭에 이전 값과 함께 남습니다."),
    h("div", { class: "row mt" }, h("button", { type: "button", class: "secondary", onclick: close }, "닫기"), save));
  document.body.append(dlg);
  dlg.showModal();
}

/** 지출 입력: a one-off expense. */
function expenseEntryCard(depts, cats) {
  const optSel = (label, rows) => h("select", { "aria-label": label }, h("option", { value: "" }, `${label} (선택)`), rows.map((x) => h("option", { value: x.id }, x.name)));
  const eDate = h("input", { type: "date", value: hobartToday(), "aria-label": "날짜" });
  const eVendor = h("input", { placeholder: "지급처 / 내용 (예: Coles, 간식)", maxlength: 100, "aria-label": "지급처 / 내용" });
  const eAmount = h("input", { inputmode: "decimal", placeholder: "0.00", "aria-label": "금액" });
  const eAccount = h("select", { "aria-label": "계정" }, h("option", { value: "cash" }, "현금"), h("option", { value: "bank" }, "은행"));
  const eDept = optSel("부서", depts), eCat = optSel("지출 항목", cats);
  const eNote = h("input", { placeholder: "메모 (선택)", maxlength: 300 });
  const eSave = h("button", { type: "button" }, "지출 저장");
  let clientKey = crypto.randomUUID();
  let sentSig = null;
  eSave.onclick = () =>
    act(eSave, async () => {
      const cents = toCents(eAmount.value);
      if (cents === null || cents <= 0) throw new Error("금액이 올바르지 않습니다. (예: 45.50)");
      if (!eVendor.value.trim()) throw new Error("지급처 / 내용을 입력하세요.");
      if (!(await ask(`${eDate.value} ${eVendor.value.trim()} ${money(cents)} 지출을 저장할까요?`, { okText: "저장" }))) return;
      const body = {
        expense_date: eDate.value, vendor: eVendor.value, total_cents: cents, account: eAccount.value,
        department_id: eDept.value ? Number(eDept.value) : null, category_id: eCat.value ? Number(eCat.value) : null, note: eNote.value || undefined,
      };
      // A resend of the same form (after a dropped reply) is not saved twice; a changed form gets a new key.
      const sig = JSON.stringify(body);
      if (sentSig !== null && sentSig !== sig) clientKey = crypto.randomUUID();
      sentSig = sig;
      await api("POST", "/api/expenses", { ...body, client_key: clientKey });
      clientKey = crypto.randomUUID();
      sentSig = null;
      eVendor.value = eAmount.value = eNote.value = "";
      toast("지출을 저장했습니다. '지출 내역'에서 볼 수 있습니다.");
    });
  return h("div", { class: "card" },
    h("h3", {}, "지출 입력"),
    h("div", { class: "grid" },
      h("div", { class: "row" }, h("div", {}, h("label", {}, "날짜"), eDate), h("div", {}, h("label", {}, "금액 ($)"), eAmount), h("div", {}, h("label", {}, "계정"), eAccount)),
      h("div", {}, h("label", {}, "지급처 / 내용"), eVendor),
      h("div", { class: "row" }, eDept, eCat), eNote, eSave),
    h("p", { class: "muted mt" }, "영수증 사진으로 입력하는 기능은 다음 단계에서 추가됩니다."));
}

function recurringCard(depts, cats, afterChange) {
  const list = h("div", { class: "chips" });
  const load = async () => {
    const rows = await api("GET", "/api/recurring-expenses");
    list.replaceChildren(...(rows.length
      ? rows.map((r) =>
          h("div", { class: `chip-item ${r.is_active ? "" : "off"}`, style: "flex-wrap:wrap" },
            h("div", { class: "grow" }, h("b", {}, r.name), " ", accountTag(r.account),
              h("div", { class: "muted" }, `${r.schedule} · ${r.amount_text ?? money(r.amount_cents)}${r.is_active ? "" : " · 중지됨"}`)),
            h("span", { class: "editor-only" },
              h("button", { type: "button", class: "mini", onclick: async (ev) => {
                const btn = ev.currentTarget;
                const text = await ask(`${r.name}\n앞으로의 ${r.amount_mode === "per_week" ? "주당 " : ""}금액 (이미 잡힌 예정 금액은 지급할 때 고칩니다)`, { input: (r.amount_cents / 100).toFixed(2), okText: "변경" });
                if (text === null) return;
                await act(btn, async () => {
                  const cents = toCents(text);
                  if (cents === null || cents <= 0) throw new Error("금액이 올바르지 않습니다.");
                  await api("PATCH", `/api/recurring-expenses/${r.id}`, { amount_cents: cents });
                  await load();
                });
              } }, "금액"),
              h("button", { type: "button", class: "mini danger-text", onclick: async (ev) => {
                const btn = ev.currentTarget;
                if (r.is_active && !(await ask(`'${r.name}'을(를) 중지할까요?\n오늘 이후로 잡혀 있던 '예정' 항목은 취소됩니다. 이미 날짜가 지난 미지급 항목은 그대로 남습니다.\n(다시 사용하면 취소된 예정 항목이 되살아납니다.)`, { okText: "중지" }))) return;
                act(btn, async () => { await api("PATCH", `/api/recurring-expenses/${r.id}`, { is_active: !r.is_active }); await load(); await afterChange(); });
              } },
                r.is_active ? "중지" : "다시 사용"))))
      : [h("p", { class: "muted" }, "등록된 고정 지출이 없습니다.")]));
  };

  // add form
  const fName = h("input", { placeholder: "이름 (예: 담임목사 사례비, 예배당 렌트비)", maxlength: 50 });
  const fVendor = h("input", { placeholder: "지급처 (선택)", maxlength: 100 });
  const fAmount = h("input", { inputmode: "decimal", placeholder: "금액 0.00 (주 단위면 1주 금액)", "aria-label": "금액" });
  const fAccount = h("select", { "aria-label": "계정" }, h("option", { value: "bank" }, "은행"), h("option", { value: "cash" }, "현금"));
  const fPerWeek = h("input", { type: "checkbox", style: "width:auto;min-height:0" });
  const perWeekBox = h("label", { style: "display:flex;gap:8px;align-items:flex-start;margin:0;color:var(--text)" }, fPerWeek,
    h("span", {}, "주 단위 금액입니다 (예: 주 $700). 지급하는 달에 그 요일이 몇 번 있는지 세어서 곱합니다. 4번이면 4주치, 5번이면 5주치."));
  const fRule = h("select", { "aria-label": "주기" },
    h("option", { value: "monthly_weekday" }, "매월 몇째 주 무슨 요일"),
    h("option", { value: "monthly_day" }, "매월 며칠"),
    h("option", { value: "weekly" }, "매주 무슨 요일"),
    h("option", { value: "fortnightly" }, "2주마다"));
  const fNth = h("select", { "aria-label": "몇째 주" }, ["첫째", "둘째", "셋째", "넷째", "마지막"].map((t, i) => h("option", { value: i + 1 }, `${t} 주`)));
  const fWeekday = h("select", { "aria-label": "요일" }, WEEKDAY_NAMES.map((t, i) => h("option", { value: i }, `${t}요일`)));
  const fDay = h("select", { "aria-label": "날짜" }, Array.from({ length: 31 }, (_, i) => h("option", { value: i + 1 }, i === 30 ? "말일" : `${i + 1}일`)));
  const fAnchor = h("input", { type: "date", "aria-label": "기준일 (한 번 낸 날)" });
  const fStart = h("input", { type: "date", value: hobartToday(), "aria-label": "시작일" });
  const fDept = h("select", { "aria-label": "부서" }, h("option", { value: "" }, "부서 (선택)"), depts.map((x) => h("option", { value: x.id }, x.name)));
  const fCat = h("select", { "aria-label": "지출 항목" }, h("option", { value: "" }, "지출 항목 (선택)"), cats.map((x) => h("option", { value: x.id }, x.name)));
  const ruleBox = h("div", { class: "row" });
  const showRule = () => {
    const v = fRule.value;
    const field = (label, el) => h("div", {}, h("label", {}, label), el);
    ruleBox.replaceChildren(...(
      v === "monthly_weekday" ? [field("몇째 주", fNth), field("요일", fWeekday)] :
      v === "monthly_day" ? [field("날짜", fDay)] :
      v === "weekly" ? [field("요일", fWeekday)] :
      [field("기준일 (한 번 낸 날)", fAnchor)]));
    perWeekBox.hidden = v !== "monthly_weekday";
    if (perWeekBox.hidden) fPerWeek.checked = false;
  };
  fRule.addEventListener("change", showRule);
  showRule();
  const fAdd = h("button", { type: "button" }, "고정 지출 등록");
  fAdd.onclick = () =>
    act(fAdd, async () => {
      const cents = toCents(fAmount.value);
      if (cents === null || cents <= 0) throw new Error("금액이 올바르지 않습니다.");
      const rule = fRule.value;
      await api("POST", "/api/recurring-expenses", {
        name: fName.value, vendor: fVendor.value || undefined, amount_cents: cents, account: fAccount.value, rule,
        amount_mode: fPerWeek.checked ? "per_week" : "fixed",
        nth: rule === "monthly_weekday" ? Number(fNth.value) : undefined,
        weekday: rule === "monthly_weekday" || rule === "weekly" ? Number(fWeekday.value) : undefined,
        day_of_month: rule === "monthly_day" ? Number(fDay.value) : undefined,
        anchor_date: rule === "fortnightly" ? fAnchor.value || undefined : undefined,
        start_date: fStart.value,
        department_id: fDept.value ? Number(fDept.value) : null, category_id: fCat.value ? Number(fCat.value) : null,
      });
      fName.value = fVendor.value = fAmount.value = "";
      toast("고정 지출을 등록했습니다. 날짜가 다가오면 지출 목록에 '예정'으로 잡힙니다.");
      await api("GET", "/api/expenses/due"); // put this week's date on the list right away
      await Promise.all([load(), afterChange()]);
    });

  const card = h("div", { class: "card" },
    h("h3", {}, "고정 지출"),
    h("p", { class: "muted" }, "매달·매주 나가는 비용입니다. 날짜가 7일 안으로 다가오면 지출 목록에 '예정'으로 잡히고, 프로그램을 열 때 알림이 뜹니다."),
    list,
    h("details", { class: "mt editor-only" }, h("summary", {}, "새 고정 지출 등록"),
      h("div", { class: "grid mt" },
        fName,
        h("div", { class: "row" }, h("div", {}, h("label", {}, "금액 ($)"), fAmount), h("div", {}, h("label", {}, "계정"), fAccount)),
        h("div", { class: "row" }, h("div", {}, h("label", {}, "주기"), fRule), h("div", {}, h("label", {}, "시작일"), fStart)),
        ruleBox,
        perWeekBox,
        fVendor,
        h("div", { class: "row" }, fDept, fCat),
        fAdd)));
  load().catch((e) => toast(e.message, true));
  return card;
}

// ---------- 교적부 ----------

const STATUS_LABELS = {
  registered: "등록", attending: "출석", inactive: "장기결석", left: "떠남",
  transferred: "이명(전출)", returned: "복귀", deceased: "별세",
};
const LEFT_CODES = new Set(["left", "transferred", "deceased"]);
const isRegistryAdmin = () => state.me?.registry_admin === true;
const statusTag = (code) =>
  code ? h("span", { class: `tag ${LEFT_CODES.has(code) ? "void" : ""}` }, STATUS_LABELS[code] ?? code) : null;
const titleTag = (t) => (t ? h("span", { class: "tag online" }, t) : null);
// The church's year, not the phone's (they differ only when travelling, but it costs nothing).
/** Age in full years on today's Hobart date, from YYYY-MM-DD. */
function ageOf(birth) {
  if (!birth) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Hobart" }).format(new Date());
  const [y, m, d] = birth.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}
const thisYear = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Hobart", year: "numeric" }).format(new Date());

async function renderRegistry() {
  const ticket = newTicket();
  const id = Number(location.hash.split("/")[1]);
  if (id) return renderRegistryMember(ticket, id);

  const q = h("input", { type: "search", placeholder: "이름 검색", "aria-label": "이름 검색" });
  const which = h("select", { "aria-label": "보기" },
    h("option", { value: "current" }, "현재 교인"),
    h("option", { value: "left" }, "떠난 분 (떠남·이명·별세)"),
    h("option", { value: "all" }, "전체"));
  const list = h("ul", { class: "list" });
  const counter = h("span", { class: "muted" });
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    const p = new URLSearchParams({ include_inactive: "1" });
    if (q.value.trim()) p.set("q", q.value.trim());
    const rows = (await api("GET", `/api/members?${p}`)).filter((m) =>
      which.value === "all" ? true : which.value === "left" ? LEFT_CODES.has(m.current_status) : !LEFT_CODES.has(m.current_status));
    if (mine !== seq) return;
    counter.textContent = `${rows.length}명`;
    list.replaceChildren(
      ...(rows.length
        ? rows.map((m) =>
            h("li", {},
              h("a", { class: "grow", href: `#registry/${m.id}`, style: "color:inherit;text-decoration:none" },
                h("b", {}, m.name), " ", titleTag(m.current_title), " ", statusTag(m.current_status),
                h("div", { class: "muted" }, [m.relation, m.birth_date ? `${ageOf(m.birth_date)}세` : null, m.member_code ? null : "직접 등록"].filter(Boolean).join(" · "))),
              h("span", { class: "muted shrink" }, "›")))
        : [h("li", { class: "muted" }, "해당하는 분이 없습니다.")]),
    );
  };
  let timer;
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => act(null, load), 250); });
  which.addEventListener("change", () => act(null, load));

  // Pastor only: people who aren't in the sheet (e.g. a regular visitor who gives).
  const name = h("input", { placeholder: "이름", maxlength: 50 });
  const relation = h("input", { placeholder: "관계 (선택, 예: 본인·자녀)", maxlength: 20 });
  const note = h("input", { placeholder: "메모 (선택)", maxlength: 300 });
  const add = h("button", { type: "button" }, "추가");
  add.onclick = () =>
    act(add, async () => {
      await api("POST", "/api/members", { name: name.value, relation: relation.value, note: note.value });
      name.value = relation.value = note.value = "";
      toast("추가했습니다.");
      await load();
    });

  const expiring = h("div");
  const loadExpiring = async () => {
    const rows = await api("GET", `/api/registry/expiring?year=${thisYear()}`);
    expiring.replaceChildren(
      ...(rows.length
        ? [h("div", { class: "card" },
            h("h3", {}, `${thisYear()}년 임기 만료 예정 (${rows.length}명)`),
            h("ul", { class: "list" }, rows.map((r) =>
              h("li", {}, h("a", { class: "grow", href: `#registry/${r.member_id}` }, `${r.member_name} · ${r.title_name}`), h("span", { class: "muted" }, `~${r.end_date}`)))))]
        : []),
    );
  };

  // Pastor only: sheet rows held back because someone with the same name was entered by hand.
  const pending = h("div");
  const loadPending = async () => {
    if (!isRegistryAdmin()) return;
    const rows = await api("GET", "/api/registry/pending");
    pending.replaceChildren(
      ...(rows.length
        ? [h("div", { class: "card" },
            h("h3", {}, `시트에서 온 분 확인 필요 (${rows.length}명)`),
            h("p", { class: "muted" }, "이미 직접 등록된 같은 이름의 분이 있습니다. 같은 분이면 '같은 분'을, 다른 분이면 '새로 등록'을 누르세요. 같은 분으로 연결하면 지난 헌금 기록이 그대로 이어집니다."),
            h("ul", { class: "list" }, rows.map((p) =>
              h("li", { style: "flex-wrap:wrap" },
                h("div", { class: "grow" }, h("b", {}, p.name), " ", h("span", { class: "muted" }, [p.relation, p.birth_date ? `${p.birth_date}생` : "생년월일 없음", p.member_code].filter(Boolean).join(" · "))),
                h("div", { class: "row shrink" },
                  ...p.candidates.map((cand) =>
                    h("button", { type: "button", class: "secondary small", onclick: async (e) => {
                      const btn = e.currentTarget;
                      if (!(await ask(`시트의 '${p.name}'(${p.member_code})을(를) 이미 등록된 '${cand.name}'${cand.note ? `(${cand.note})` : ""}과(와) 같은 분으로 연결할까요?`))) return;
                      act(btn, async () => { await api("POST", `/api/registry/pending/${p.member_code}/link`, { member_id: cand.id }); toast("연결했습니다."); await Promise.all([load(), loadPending()]); });
                    } }, `같은 분: ${cand.name} (${[cand.birth_date ? `${cand.birth_date}생` : "생년월일 없음", cand.relation, cand.note].filter(Boolean).join(", ")})`)),
                  h("button", { type: "button", class: "small", onclick: async (e) => {
                    const btn = e.currentTarget;
                    if (!(await ask(`'${p.name}'을(를) 다른 분으로 새로 등록할까요?`))) return;
                    act(btn, async () => { await api("POST", `/api/registry/pending/${p.member_code}/create`, {}); toast("새로 등록했습니다."); await Promise.all([load(), loadPending()]); });
                  } }, "새로 등록"))))))]
        : []),
    );
  };

  paint(ticket,
    h("h2", {}, "교적부"),
    importCard(() => Promise.all([load(), loadExpiring(), loadPending()])),
    pending,
    h("p", { class: "muted" }, "새가족은 목양 시트에서 자동으로 들어옵니다. 직분과 출석 상태는 여기에서 관리합니다."),
    expiring,
    h("div", { class: "card" },
      h("div", { class: "row" }, q, which),
      h("div", { class: "mt" }, counter),
      list),
    h("div", { class: "card registry-only" }, h("h3", {}, "직접 추가 (시트에 없는 분)"), h("div", { class: "grid" }, name, relation, note, add)),
  );
  await act(null, () => Promise.all([load(), loadExpiring(), loadPending()]));
}

async function renderRegistryMember(ticket, id) {
  const [m, titles] = await Promise.all([api("GET", `/api/registry/members/${id}`), api("GET", "/api/registry/titles")]);
  const reload = () => { renderRegistry(); };

  const voidBtn = (path, what) =>
    h("button", { type: "button", class: "danger small registry-only", onclick: async (e) => {
      const btn = e.currentTarget;
      const reason = await ask(`${what}\n이 기록을 취소합니다. 사유를 입력하세요.`, { input: "", okText: "취소 처리", cancelText: "닫기", required: true });
      if (reason === null) return;
      act(btn, async () => { await api("POST", path, { reason }); toast("취소했습니다."); reload(); });
    } }, "취소");

  // 직분 추가
  const titleSel = h("select", { "aria-label": "직분" }, h("option", { value: "" }, "직분 선택"),
    titles.filter((t) => t.is_active).map((t) => h("option", { value: t.id }, t.term_limited ? `${t.name} (1년 임기)` : t.name)));
  const tStart = h("input", { type: "date", value: hobartToday(), "aria-label": "시작일" });
  const tEnd = h("input", { type: "date", "aria-label": "종료일" });
  const tNote = h("input", { placeholder: "메모 (선택)", maxlength: 300 });
  const syncEnd = () => {
    const t = titles.find((x) => String(x.id) === titleSel.value);
    tEnd.value = t?.term_limited && tStart.value ? `${tStart.value.slice(0, 4)}-12-31` : "";
  };
  titleSel.addEventListener("change", syncEnd);
  tStart.addEventListener("change", syncEnd);
  syncEnd();
  const tAdd = h("button", { type: "button" }, "직분 추가");
  tAdd.onclick = () =>
    act(tAdd, async () => {
      const t = titles.find((x) => String(x.id) === titleSel.value);
      if (!t) throw new Error("직분을 고르세요.");
      if (!(await ask(`${m.name}: ${t.name}\n${tStart.value} ~ ${tEnd.value || "(계속)"}\n이렇게 기록할까요?`, { okText: "기록" }))) return;
      await api("POST", `/api/registry/members/${id}/titles`, {
        title_id: Number(titleSel.value), start_date: tStart.value, end_date: tEnd.value || null, note: tNote.value || undefined,
      });
      toast("직분을 기록했습니다.");
      reload();
    });

  // 상태 추가
  const sSel = h("select", { "aria-label": "상태" }, h("option", { value: "" }, "상태 선택"),
    Object.entries(STATUS_LABELS).filter(([k]) => k !== "registered").map(([k, v]) => h("option", { value: k }, v)));
  const sDate = h("input", { type: "date", value: hobartToday(), max: hobartToday(), "aria-label": "날짜" });
  const sNote = h("input", { placeholder: "메모 (선택)", maxlength: 300 });
  const sAdd = h("button", { type: "button" }, "상태 기록");
  sAdd.onclick = () =>
    act(sAdd, async () => {
      if (!sSel.value) throw new Error("상태를 고르세요.");
      const label = STATUS_LABELS[sSel.value];
      const warn = LEFT_CODES.has(sSel.value) ? "\n이렇게 기록하면 헌금 입력의 이름 목록에서 빠집니다. (지난 기록은 그대로 남습니다.)" : "";
      if (!(await ask(`${m.name}: ${sDate.value} ${label}${warn}\n기록할까요?`, { okText: "기록" }))) return;
      await api("POST", `/api/registry/members/${id}/status`, { status_code: sSel.value, event_date: sDate.value, note: sNote.value || undefined });
      toast("상태를 기록했습니다.");
      reload();
    });

  const years = [...new Set(m.giving_by_year.map((g) => g.year))];
  paint(ticket,
    h("p", {}, h("a", { href: "#registry" }, "‹ 교적부 목록")),
    h("h2", {}, m.name, " ", titleTag(m.current_title), " ", statusTag(m.current_status)),
    h("div", { class: "card" },
      h("ul", { class: "list" },
        h("li", {}, h("span", {}, "관계"), h("b", {}, m.relation ?? "-")),
        h("li", {}, h("span", {}, "생년월일"),
          h("span", {}, h("b", {}, m.birth_date ? `${m.birth_date} (${ageOf(m.birth_date)}세)` : "-"), " ",
            h("button", { type: "button", class: "mini registry-only", onclick: async (ev) => {
              const btn = ev.currentTarget;
              const v = await ask(`${m.name}의 생년월일 (YYYY-MM-DD)\n같은 이름의 분을 구분하고, 시트 연동 때 같은 분을 찾는 데 쓰입니다.`, { input: m.birth_date ?? "", okText: "저장" });
              if (v === null) return;
              act(btn, async () => {
                const val = v.trim();
                if (val && !isRealYmd(val)) throw new Error("YYYY-MM-DD 형식의 실제 날짜를 넣으세요. (예: 1960-05-01)");
                await api("PATCH", `/api/members/${id}`, { birth_date: val || null, expected: { birth_date: m.birth_date } });
                toast("생년월일을 저장했습니다.");
                reload();
              });
            } }, "수정"))),
        h("li", {}, h("span", {}, "교인ID"), h("b", {}, m.member_code ?? "직접 등록")),
        h("li", {}, h("span", {}, "등록일"), h("b", {}, m.registered_on ?? "-")),
        m.family.length
          ? h("li", {}, h("span", {}, "가족"), h("span", { class: "grow", style: "text-align:right" },
              m.family.flatMap((f, i) => [i ? ", " : "", h("a", { href: `#registry/${f.id}` }, `${f.name}${f.relation ? `(${f.relation}${f.birth_date ? `, ${ageOf(f.birth_date)}세` : ""})` : ""}`)])))
          : null)),
    h("div", { class: "card" },
      h("h3", {}, "직분 이력"),
      m.titles.length
        ? h("ul", { class: "list" }, m.titles.map((t) =>
            h("li", { class: t.status === "void" ? "void-row" : "" },
              h("div", { class: "grow" }, h("b", {}, t.title_name), ` ${t.start_date} ~ ${t.end_date ?? ""}`,
                t.note ? h("div", { class: "muted" }, t.note) : null,
                t.status === "void" ? h("div", {}, h("span", { class: "tag void" }, "취소됨"), " ", t.void_reason) : null),
              t.status === "active" ? voidBtn(`/api/registry/member-titles/${t.id}/void`, `${t.title_name} ${t.start_date}`) : null)))
        : h("p", { class: "muted" }, "직분 기록이 없습니다."),
      h("div", { class: "grid mt registry-only" },
        h("div", { class: "row" }, h("div", {}, h("label", {}, "직분"), titleSel), h("div", {}, h("label", {}, "시작일"), tStart), h("div", {}, h("label", {}, "종료일 (비우면 계속)"), tEnd)),
        tNote, tAdd)),
    h("div", { class: "card" },
      h("h3", {}, "출석 상태 이력"),
      h("ul", { class: "list" }, m.statuses.map((s) =>
        h("li", { class: s.status === "void" ? "void-row" : "" },
          h("div", { class: "grow" }, statusTag(s.status_code), ` ${s.event_date}`,
            s.note ? h("div", { class: "muted" }, s.note) : null,
            s.status === "void" ? h("div", {}, h("span", { class: "tag void" }, "취소됨"), " ", s.void_reason) : null),
          s.status === "active" ? voidBtn(`/api/registry/status-events/${s.id}/void`, `${STATUS_LABELS[s.status_code]} ${s.event_date}`) : null))),
      h("div", { class: "grid mt registry-only" },
        h("div", { class: "row" }, h("div", {}, h("label", {}, "상태"), sSel), h("div", {}, h("label", {}, "날짜"), sDate)),
        sNote, sAdd)),
    h("div", { class: "card" },
      h("h3", {}, "헌금 합계 (연도별)"),
      years.length
        ? h("table", {}, h("tbody", {}, years.flatMap((y) => {
            const rows = m.giving_by_year.filter((g) => g.year === y);
            const total = rows.reduce((s, g) => s + g.total_cents, 0);
            return [
              h("tr", {}, h("th", {}, `${y}년`), h("th", { class: "num" }, money(total))),
              ...rows.map((g) => h("tr", {}, h("td", { class: "muted" }, `${g.fund_type_name} (${g.count}건)`), h("td", { class: "num" }, money(g.total_cents)))),
            ];
          })))
        : h("p", { class: "muted" }, "헌금 기록이 없습니다.")),
  );
}

// ---------- 시트에서 가져오기 (CSV) ----------

/** RFC 4180 CSV: quoted fields may contain commas, quotes ("") and line breaks (memo cells do). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, quoted = false;
  text = text.replace(/^\uFEFF/, "").replace(/\r(?!\n)/g, "\n"); // old Mac CR-only line endings
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** "1960-05-01", "1960-05-01 14:30:51", "1960. 5. 1" -> "1960-05-01"; otherwise null. */
function csvDate(v) {
  const m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/.exec(String(v).trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

// Only these columns are read. Everything else in the file (memo, prayer requests, address…) is ignored
// in the browser and never sent.
const CSV_COLUMNS = { member_code: "교인ID", family_code: "가정ID", name: "이름", relation: "관계", birth_date: "생년월일", title: "직분", registered_at: "등록일시", first_registered: "최초등록일" };

function peopleFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("빈 파일입니다.");
  const header = rows[0].map((v) => v.trim());
  const col = Object.fromEntries(Object.entries(CSV_COLUMNS).map(([k, t]) => [k, header.indexOf(t)]));
  if (col.member_code < 0 || col.name < 0) throw new Error("'교인ID'와 '이름' 열이 있는 교인목록 탭의 CSV인지 확인하세요.");
  const used = Object.values(col).filter((i) => i >= 0).length;
  const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? "").normalize("NFC").trim() : "");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Hobart" }).format(new Date());
  const people = [], skipped = [], noBirth = [];
  rows.slice(1).forEach((r, i) => {
    const code = get(r, "member_code"), name = get(r, "name");
    if (!code && !name) return;
    const family = get(r, "family_code"), relation = get(r, "relation"), title = get(r, "title");
    const problem =
      !/^[A-Za-z0-9-]{3,40}$/.test(code) ? "교인ID" :
      family && !/^[A-Za-z0-9-]{3,40}$/.test(family) ? "가정ID" :
      !name || name.length > 50 ? "이름" : relation.length > 20 ? "관계" : title.length > 20 ? "직분" : "";
    if (problem) { skipped.push(`${i + 2}행(${problem})`); return; }
    let birth = csvDate(get(r, "birth_date"));
    if (birth && (birth < "1900-01-01" || birth > today || !isRealYmd(birth))) birth = null;
    if (!birth && get(r, "birth_date")) noBirth.push(`${i + 2}행`);
    const reg = csvDate(get(r, "first_registered")) || csvDate(get(r, "registered_at"));
    people.push({
      member_code: code, family_code: family || null, name, relation: relation || null,
      birth_date: birth, title: title || null,
      registered_on: reg && reg >= "2000-01-01" && reg <= "2100-12-31" ? reg : null,
    });
  });
  return { people, skipped, noBirth, used, ignored: header.length - used };
}

/**
 * The church roster (교인명부): 구분, 직분/학년, 성명, 성별, 생년월일, 만 나이, 연락처. No IDs.
 * 주일학교 rows keep their grade as a note instead of a title.
 */
function peopleFromRoster(rows) {
  const header = rows[0].map((v) => v.trim());
  const idx = (t) => header.indexOf(t);
  const c = { kind: idx("구분"), title: idx("직분/학년"), name: idx("성명"), birth: idx("생년월일"), phone: idx("연락처") };
  const get = (r, i) => (i >= 0 ? String(r[i] ?? "").normalize("NFC").trim() : "");
  const blank = (v) => (v === "-" ? "" : v);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Hobart" }).format(new Date());
  const people = [], skipped = [], noBirth = [];
  rows.slice(1).forEach((r, i) => {
    const name = blank(get(r, c.name));
    if (!name) return;
    if (name.length > 50) { skipped.push(`${i + 2}행(성명)`); return; }
    const kind = blank(get(r, c.kind)), sub = blank(get(r, c.title));
    const school = kind === "주일학교";
    let birth = csvDate(blank(get(r, c.birth)));
    if (birth && (birth < "1900-01-01" || birth > today || !isRealYmd(birth))) birth = null;
    if (!birth && blank(get(r, c.birth))) noBirth.push(`${i + 2}행`);
    const title = school ? "" : sub || kind;
    people.push({
      name, birth_date: birth,
      phone: blank(get(r, c.phone)).slice(0, 30) || null,
      title: title.slice(0, 20) || null,
      note: school ? `주일학교 ${sub}`.trim().slice(0, 100) : null,
    });
  });
  const used = Object.values(c).filter((i) => i >= 0).length;
  return { people, skipped, noBirth, used, ignored: header.length - used };
}

function importCard(after) {
  const file = h("input", { type: "file", accept: ".csv,text/csv", "aria-label": "CSV 파일" });
  const out = h("div", { class: "muted" });
  const go = h("button", { type: "button" }, "가져오기");
  go.onclick = () =>
    act(go, async () => {
      out.textContent = "파일을 확인하는 중…";
      try {
        await runImport();
      } catch (err) {
        out.replaceChildren(h("div", { class: "notice" }, `가져오지 못했습니다: ${err.message}`));
        throw err;
      }
    });
  const runImport = async () => {
      const f = file.files?.[0];
      if (!f) throw new Error("CSV 파일을 고르세요.");
      const text = await f.text();
      const header = (parseCsv(text)[0] ?? []).map((v) => v.trim());
      // Two layouts: the 목양 sheet's 교인목록 tab (has 교인ID) or the church roster (has 성명).
      const isRoster = !header.includes("교인ID") && header.includes("성명");
      const { people, skipped, noBirth, used, ignored } = isRoster ? peopleFromRoster(parseCsv(text)) : peopleFromCsv(text);
      if (!people.length) throw new Error("가져올 사람이 없습니다.");
      const kind = isRoster ? "교인명부" : "목양 시트 교인목록";
      if (!(await ask(`[${kind}] ${people.length}명을 교적부로 가져옵니다.\n읽는 칸 ${used}개, 읽지 않고 버리는 칸 ${ignored}개.\n계속할까요?`, { okText: "가져오기" }))) {
        out.textContent = "가져오기를 취소했습니다.";
        return;
      }
      out.textContent = `${people.length}명을 보내는 중…`;
      const total = { created: 0, updated: 0, pending: 0, unchanged: 0, unknown: new Set(), ambiguous: [] };
      for (let i = 0; i < people.length; i += 100) {
        let r;
        try {
          r = await api("POST", isRoster ? "/api/registry/import-roster" : "/api/registry/import", { people: people.slice(i, i + 100) });
        } catch (err) {
          throw new Error(`${i + 1}~${Math.min(i + 100, people.length)}번째 사람을 보내다 멈췄습니다 (${err.message}). ` +
            (i ? `그 앞의 ${i}명은 이미 들어갔습니다. 파일을 고친 뒤 다시 가져오면 중복 없이 이어집니다.` : "아무것도 들어가지 않았습니다."));
        }
        total.created += r.created; total.updated += r.updated; total.pending += r.pending ?? 0; total.unchanged += r.unchanged;
        r.unknown_titles.forEach((t) => total.unknown.add(t));
        total.ambiguous.push(...(r.ambiguous ?? []));
      }
      out.replaceChildren(...[
        h("div", {}, `새로 등록 ${total.created}명 · 변경 ${total.updated}명 · 그대로 ${total.unchanged}명${total.pending ? ` · 확인 필요 ${total.pending}명` : ""}`),
        skipped.length ? h("div", {}, `형식이 맞지 않아 건너뛴 줄: ${skipped.join(", ")}`) : null,
        noBirth.length ? h("div", {}, `생년월일을 읽지 못한 줄 (나머지는 가져옴): ${noBirth.join(", ")}`) : null,
        total.unknown.size ? h("div", {}, `목록에 없는 직분이라 기록하지 않음: ${[...total.unknown].join(", ")}`) : null,
        total.ambiguous.length ? h("div", {}, `같은 분인지 확실하지 않아 건너뜀 (교인 상세에서 생년월일을 넣은 뒤 다시 가져오세요): ${total.ambiguous.join(", ")}`) : null,
      ].filter(Boolean));
      file.value = "";
      toast("가져왔습니다.");
      await after();
  };
  return h("details", { class: "card registry-only" },
    h("summary", {}, h("b", {}, "교인명부 / 목양 시트에서 가져오기 (CSV)")),
    h("p", { class: "muted mt" }, "두 가지 CSV를 받습니다. ① 교인명부(구분·직분/학년·성명·생년월일·연락처): 이름과 생년월일로 같은 분을 찾습니다. ② 목양 시트 '교인목록' 탭: 교인ID·가정ID·이름·관계·생년월일·직분·등록일만 읽습니다. 그 밖의 칸(메모·기도제목·주소 등)은 이 화면에서 버려져 서버로 가지 않습니다. 여러 번 가져와도 중복되지 않고, 직분은 처음 한 번만 기록됩니다."),
    h("div", { class: "row" }, file, h("div", { class: "shrink" }, go)),
    out);
}

function titlesCard() {
  // The title list is fixed for this church; only shown here. Titles are given to people in 교적부.
  const list = h("div", { class: "chips" });
  const load = async () => {
    const rows = await api("GET", "/api/registry/titles");
    list.replaceChildren(...rows.filter((t) => t.is_active).map((t) =>
      h("div", { class: "chip-item" }, h("span", { class: "grow" }, t.name), t.term_limited ? h("span", { class: "tag" }, "1년 임기") : null)));
  };
  const card = h("div", { class: "card" }, h("h3", {}, "직분"), list,
    h("p", { class: "muted mt" }, "직분은 교적부에서 각 교인에게 기록합니다. 서리집사는 1년 임기로, 종료일이 그해 12월 31일로 자동 입력됩니다."));
  return { card, load };
}

// ---------- 설정 ----------

function lookupCard(title, path) {
  // Compact: items flow in a grid (2+ per row on wider screens) with small inline actions.
  const list = h("div", { class: "chips" });
  const load = async () => {
    const rows = await api("GET", `${path}?include_inactive=1`);
    list.replaceChildren(
      ...(rows.length
        ? rows.map((r) =>
            h("div", { class: `chip-item ${r.is_active ? "" : "off"}` },
              h("span", { class: "grow" }, r.name, r.is_active ? "" : h("span", { class: "muted" }, " (중지)")),
              h("span", { class: "editor-only" },
                h("button", { type: "button", class: "mini", title: "이름 변경", onclick: async (e) => {
                  const btn = e.currentTarget;
                  const name = await ask("새 이름", { input: r.name, okText: "변경" });
                  if (name === null) return;
                  act(btn, async () => { await api("PATCH", `${path}/${r.id}`, { name }); await load(); });
                } }, "변경"),
                h("button", { type: "button", class: "mini danger-text", onclick: (e) =>
                  act(e.currentTarget, async () => { await api("PATCH", `${path}/${r.id}`, { is_active: !r.is_active }); await load(); }) },
                  r.is_active ? "중지" : "사용"))))
        : [h("p", { class: "muted" }, "항목이 없습니다.")]),
    );
  };
  const input = h("input", { placeholder: "새 항목 이름", maxlength: 50 });
  const add = h("button", { type: "button", class: "shrink" }, "추가");
  add.onclick = () =>
    act(add, async () => {
      await api("POST", path, { name: input.value, sort_order: 100 });
      input.value = "";
      await load();
    });
  const card = h("div", { class: "card" }, h("h3", {}, title), list, h("div", { class: "row mt editor-only" }, input, add));
  return { card, load };
}

function openingBalanceCard() {
  const body = h("div");
  const load = async () => {
    const rows = await api("GET", "/api/opening-balances");
    const byAccount = Object.fromEntries(rows.map((r) => [r.account, r]));
    body.replaceChildren(
      ...["cash", "bank"].map((account) => {
        const label = account === "cash" ? "현금 보관분" : "은행 계좌";
        const cur = byAccount[account];
        if (cur) {
          return h("div", { class: "line" },
            h("div", { class: "head" }, h("b", {}, label), h("span", {}, `${cur.as_of_date} 기준`)),
            h("div", { class: "row" },
              h("div", {}, h("b", { style: "font-size:18px" }, money(cur.amount_cents)), cur.note ? h("div", { class: "muted" }, cur.note) : null),
              h("div", { class: "shrink editor-only" }, h("button", { type: "button", class: "danger small", onclick: async (e) => {
                const btn = e.currentTarget;
                const reason = await ask(`${label} 시작 잔액 ${money(cur.amount_cents)}을 취소합니다. 사유를 입력하세요.`, { input: "", okText: "취소 처리", cancelText: "닫기", required: true });
                if (reason === null) return;
                act(btn, async () => { await api("POST", `/api/opening-balances/${cur.id}/void`, { reason }); await load(); });
              } }, "취소"))));
        }
        const date = h("input", { type: "date", value: hobartToday() });
        const amount = h("input", { inputmode: "decimal", placeholder: "0.00" });
        const note = h("input", { placeholder: "메모 (선택)", maxlength: 300 });
        const save = h("button", { type: "button" }, "저장");
        save.onclick = () =>
          act(save, async () => {
            const cents = toCents(amount.value, { allowNegative: true });
            if (cents === null) throw new Error("금액이 올바르지 않습니다. (예: 12500 또는 12500.50)");
            if (!(await ask(`${label} 시작 잔액을 ${date.value} 기준 ${money(cents)}으로 저장할까요?`, { okText: "저장" }))) return;
            await api("POST", "/api/opening-balances", { account, as_of_date: date.value, amount_cents: cents, note: note.value || undefined });
            toast("저장했습니다.");
            await load();
          });
        return h("div", { class: "line" },
          h("div", { class: "head" }, h("b", {}, label), h("span", {}, "미입력")),
          h("div", { class: "grid editor-only" },
            h("div", { class: "row" }, h("div", {}, h("label", {}, "기준일"), date), h("div", {}, h("label", {}, "금액 ($)"), amount)),
            note, save));
      }),
    );
  };
  const card = h("div", { class: "card" },
    h("h3", {}, "시작 잔액"),
    h("p", { class: "muted" }, "합병 후 장부를 시작하는 시점의 실제 보유 금액입니다. 잘못 입력했다면 취소한 뒤 다시 입력하세요."),
    body);
  return { card, load };
}

async function renderSettings() {
  const ticket = newTicket();
  const cards = [
    openingBalanceCard(),
    lookupCard("헌금 종류", "/api/fund-types"),
    titlesCard(),
    lookupCard("부서", "/api/departments"),
    lookupCard("지출 항목", "/api/expense-categories"),
  ];
  const s = state.settings;
  paint(ticket, 
    h("h2", {}, "설정"),
    h("div", { class: "card" },
      h("h3", {}, "기본 정보"),
      h("ul", { class: "list" },
        h("li", {}, h("span", {}, "교회"), h("b", {}, s.church_name ?? "")),
        h("li", {}, h("span", {}, "교회 회계연도 시작"), h("b", {}, `${s.church_fiscal_year_start_month ?? "?"}월`)),
        h("li", {}, h("span", {}, "호주 보고 연도 시작"), h("b", {}, `${s.au_fiscal_year_start_month ?? "?"}월`)),
        h("li", {}, h("span", {}, "내 계정"), h("b", {}, roleText())))),
    ...cards.map((c) => c.card),
  );
  await act(null, () => Promise.all(cards.map((c) => c.load())));
}

// ---------- 기록 ----------

const TABLE_NAMES = {
  fund_types: "헌금 종류", departments: "부서", expense_categories: "지출 항목",
  expenses: "지출", recurring_expenses: "고정 지출",
  opening_balances: "시작 잔액", members: "교적부", offerings: "헌금",
  titles: "직분 목록", member_titles: "직분", member_status_events: "출석 상태",
};
const ACTION_NAMES = { create: "추가", update: "수정", void: "취소" };

function describe(entry) {
  const a = entry.after ?? {};
  const b = entry.before ?? {};
  const parts = [];
  if (a.name) parts.push(b.name && b.name !== a.name ? `${b.name} → ${a.name}` : a.name);
  if (a.amount_cents !== undefined) parts.push(money(a.amount_cents));
  if (entry.action === "void") parts.push(b.amount_cents !== undefined ? money(b.amount_cents) : "", `사유: ${a.void_reason ?? ""}`);
  if (a.is_active !== undefined && b.is_active !== undefined && a.is_active !== b.is_active) parts.push(a.is_active ? "다시 사용" : "사용 중지");
  if (a.offering_date) parts.push(a.offering_date);
  if (a.vendor && !a.name) parts.push(a.vendor);
  if (a.total_cents !== undefined) parts.push(money(a.total_cents));
  if (a.expense_date) parts.push(a.expense_date);
  if (a.status === "confirmed" && b.status === "planned") parts.push("지급 완료");
  if (entry.action === "void" && b.total_cents !== undefined) parts.push(money(b.total_cents));
  if (a.title_name) parts.push(`${a.title_name} ${a.start_date ?? ""}~${a.end_date ?? ""}`);
  if (a.status_code) parts.push(`${STATUS_LABELS[a.status_code] ?? a.status_code} ${a.event_date ?? ""}`);
  return parts.filter(Boolean).join(" · ");
}

async function renderAudit() {
  const ticket = newTicket();
  const list = h("ul", { class: "list" });
  const more = h("button", { type: "button", class: "secondary mt" }, "더 보기");
  let lastId = 0;
  const load = async () => {
    const rows = await api("GET", `/api/audit-log?limit=50${lastId ? `&before_id=${lastId}` : ""}`);
    if (!rows.length && !lastId) list.append(h("li", { class: "muted" }, "기록이 없습니다."));
    for (const r of rows) {
      list.append(h("li", {}, h("div", { class: "grow" },
        h("div", {}, h("span", { class: "tag" }, TABLE_NAMES[r.table_name] ?? r.table_name), " ", h("b", {}, ACTION_NAMES[r.action] ?? r.action), " ", describe(r)),
        h("div", { class: "muted" }, `${new Date(r.at).toLocaleString("ko-KR")} · ${r.user_email}`))));
    }
    if (rows.length) lastId = rows[rows.length - 1].id;
    more.hidden = rows.length < 50;
  };
  more.onclick = () => act(more, load);
  paint(ticket, h("h2", {}, "보고·기록"), reportSeg("audit"), h("p", { class: "muted mt" }, "누가, 언제, 무엇을 바꿨는지 모두 남습니다. 지울 수 없습니다."), h("div", { class: "card" }, list), more);
  await act(null, load);
}

// ---------- 보고서 · 내보내기 ----------

const reportSeg = (active) =>
  h("div", { class: "seg mt", role: "tablist" },
    h("button", { type: "button", class: active === "reports" ? "on" : "", onclick: () => { location.hash = "#reports"; } }, "보고서·내보내기"),
    h("button", { type: "button", class: active === "audit" ? "on" : "", onclick: () => { location.hash = "#audit"; } }, "변경 기록"));

/** Quarter / year ranges for a fiscal year that starts in `startMonth` (1 = church, 7 = Australian). */
function fiscalRange(startMonth, fyStartYear, part) {
  const monthStart = (y, m) => `${y + Math.floor((m - 1) / 12)}-${pad(((m - 1) % 12) + 1)}-01`;
  const lastDay = (y, m) => {
    const yy = y + Math.floor((m - 1) / 12), mm = ((m - 1) % 12) + 1;
    return `${yy}-${pad(mm)}-${pad(new Date(Date.UTC(yy, mm, 0)).getUTCDate())}`;
  };
  if (part === "year") return { from: monthStart(fyStartYear, startMonth), to: lastDay(fyStartYear, startMonth + 11) };
  const q = Number(part.slice(1));
  return { from: monthStart(fyStartYear, startMonth + 3 * (q - 1)), to: lastDay(fyStartYear, startMonth + 3 * q - 1) };
}

async function renderReports() {
  const ticket = newTicket();
  const churchStart = Number(state.settings.church_fiscal_year_start_month || 1);
  const auStart = Number(state.settings.au_fiscal_year_start_month || 7);
  const saved = (() => { try { return JSON.parse(localStorage.getItem("report-period") || "{}"); } catch { return {}; } })();

  const basis = h("select", { "aria-label": "회계연도 기준" },
    h("option", { value: "church" }, `교회 회계연도 (${churchStart}월 시작)`),
    h("option", { value: "au" }, `호주 회계연도 (${auStart}월 시작)`));
  basis.value = saved.basis === "au" ? "au" : "church";
  const year = h("select", { "aria-label": "연도" });
  const part = h("select", { "aria-label": "기간" },
    h("option", { value: "year" }, "연간"), h("option", { value: "q1" }, "1분기"), h("option", { value: "q2" }, "2분기"),
    h("option", { value: "q3" }, "3분기"), h("option", { value: "q4" }, "4분기"), h("option", { value: "custom" }, "직접 지정"));
  part.value = saved.part || "year";
  const from = h("input", { type: "date", "aria-label": "시작일" });
  const to = h("input", { type: "date", "aria-label": "종료일" });
  const out = h("div");

  const startMonth = () => (basis.value === "au" ? auStart : churchStart);
  const fillYears = () => {
    const t = hobartToday();
    const ty = +t.slice(0, 4), tm = +t.slice(5, 7);
    const current = tm >= startMonth() ? ty : ty - 1; // the fiscal year we are in now
    const keep = year.value;
    year.replaceChildren(...[0, 1, 2, 3].map((i) => {
      const y = current - i;
      const label = startMonth() === 1 ? `${y}년` : `${y}-${String(y + 1).slice(2)} (${y}.${startMonth()}~${y + 1}.${startMonth() - 1})`;
      return h("option", { value: y }, label);
    }));
    year.value = keep && [...year.options].some((o) => o.value === keep) ? keep : String(saved.basis === basis.value && saved.year ? saved.year : current);
    if (!year.value) year.value = String(current);
  };
  const fillDates = () => {
    const custom = part.value === "custom";
    from.disabled = to.disabled = !custom;
    year.disabled = custom;
    if (!custom || !from.value || !to.value) {
      // 직접 지정 starts from the dates last shown, or the chosen year when there are none.
      const r = fiscalRange(startMonth(), Number(year.value), custom ? "year" : part.value);
      from.value = r.from;
      to.value = r.to;
    }
  };
  const remember = () => {
    try { localStorage.setItem("report-period", JSON.stringify({ basis: basis.value, year: year.value, part: part.value, from: from.value, to: to.value })); } catch { /* ignore */ }
  };

  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    if (!isRealYmd(from.value) || !isRealYmd(to.value)) { out.replaceChildren(h("p", { class: "notice" }, "기간을 고르세요.")); return; }
    if (from.value > to.value) { out.replaceChildren(h("p", { class: "notice" }, "시작일이 종료일보다 늦습니다.")); return; }
    const s = await api("GET", `/api/reports/summary?from=${from.value}&to=${to.value}`);
    if (mine !== seq) return;
    const b = (a) => s.balances.find((x) => x.account === a);
    const m = (c) => (c === null || c === undefined ? "-" : money(c));
    const both = (x, y) => (x === null || y === null ? null : x + y);
    const row = (label, cash, bank, total, cls) => h("tr", { class: cls ?? "" }, h("td", {}, label), h("td", { class: "num" }, m(cash)), h("td", { class: "num" }, m(bank)), h("td", { class: "num" }, m(total)));
    out.replaceChildren(...[
      h("div", { class: "card" },
        h("h3", {}, `${s.from} ~ ${s.to}`),
        h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", { class: "num" }, "현금"), h("th", { class: "num" }, "은행·온라인"), h("th", { class: "num" }, "합계"))),
          h("tbody", {},
            row("기간 시작 잔액", b("cash").start_cents, b("bank").start_cents, both(b("cash").start_cents, b("bank").start_cents), "strong-row"),
            row("+ 수입 (헌금)", s.income.cash_cents, s.income.online_cents, s.income.total_cents),
            row("− 지출 (지급)", s.expenses.cash_cents, s.expenses.bank_cents, s.expenses.total_cents),
            row("기간 끝 잔액", b("cash").end_cents, b("bank").end_cents, both(b("cash").end_cents, b("bank").end_cents), "strong-row"))),
        s.planned_unpaid.count ? h("p", { class: "muted mt" }, `아직 지급하지 않은 고정 지출 ${s.planned_unpaid.count}건, ${money(s.planned_unpaid.total_cents)} (잔액에 들어가지 않음)`) : null,
        ...s.notes.map((n) => h("p", { class: "notice mt" }, n))),
      h("div", { class: "card" },
        h("h3", {}, "수입 (헌금 종류별)"),
        s.income.rows.length
          ? h("table", {}, h("tbody", {}, s.income.rows.map((r) => h("tr", {}, h("td", {}, `${r.name} `, methodTag(r.method)), h("td", { class: "muted num" }, `${r.count}건`), h("td", { class: "num" }, money(r.total_cents))))))
          : h("p", { class: "muted" }, "이 기간에 헌금이 없습니다.")),
      h("div", { class: "card" },
        h("h3", {}, "지출 (부서별)"),
        s.expenses.by_department.length
          ? h("table", {}, h("tbody", {}, s.expenses.by_department.map((r) => h("tr", {}, h("td", {}, r.name), h("td", { class: "muted num" }, `${r.count}건`), h("td", { class: "num" }, money(r.total_cents))))))
          : h("p", { class: "muted" }, "이 기간에 지출이 없습니다."),
        s.expenses.by_category.length ? h("h3", { class: "mt" }, "지출 (항목별)") : null,
        s.expenses.by_category.length
          ? h("table", {}, h("tbody", {}, s.expenses.by_category.map((r) => h("tr", {}, h("td", {}, r.name), h("td", { class: "muted num" }, `${r.count}건`), h("td", { class: "num" }, money(r.total_cents))))))
          : null,
        s.expenses.gst_cents ? h("p", { class: "muted mt" }, `지출 중 GST: ${money(s.expenses.gst_cents)}`) : null),
    ].filter(Boolean));
  };
  const refresh = () => { fillDates(); remember(); act(null, load); };
  basis.addEventListener("change", () => { fillYears(); refresh(); });
  year.addEventListener("change", refresh);
  part.addEventListener("change", refresh);
  for (const el of [from, to]) el.addEventListener("change", () => { remember(); act(null, load); });

  /** Downloads a CSV from the server (same login), keeping the server's file name. */
  const download = (kind, label) => {
    const btn = h("button", { type: "button", class: "secondary" }, label);
    btn.onclick = () =>
      act(btn, async () => {
        if (!isRealYmd(from.value) || !isRealYmd(to.value) || from.value > to.value) throw new Error("기간을 확인하세요.");
        const res = await fetch(`/api/reports/${kind}.csv?from=${from.value}&to=${to.value}`, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `내려받지 못했습니다 (${res.status})`);
        const name = `${kind}_${from.value}_${to.value}.csv`; // same ASCII name the server sends
        const url = URL.createObjectURL(await res.blob());
        const a = h("a", { href: url, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast(`${name} 을(를) 내려받았습니다.`);
      });
    return btn;
  };

  fillYears();
  if (part.value === "custom" && isRealYmd(saved.from ?? "") && isRealYmd(saved.to ?? "")) {
    from.value = saved.from;
    to.value = saved.to;
  }
  fillDates();
  paint(ticket,
    h("h2", {}, "보고·기록"),
    reportSeg("reports"),
    h("div", { class: "card mt" },
      h("div", { class: "row" }, h("div", {}, h("label", {}, "기준"), basis)),
      h("div", { class: "row mt" }, h("div", {}, h("label", {}, "연도"), year), h("div", {}, h("label", {}, "기간"), part)),
      h("div", { class: "row mt" }, h("div", {}, h("label", {}, "시작일"), from), h("div", {}, h("label", {}, "종료일"), to))),
    out,
    h("div", { class: "card" },
      h("h3", {}, "내보내기 (엑셀 · 넘버스 · 구글 시트)"),
      h("p", { class: "muted" }, "위에서 고른 기간의 내역을 CSV 파일로 내려받습니다. 엑셀이나 넘버스에서 바로 열리고, 구글 시트에서는 [파일] → [가져오기]로 엽니다. 취소된 항목도 '상태'와 함께 들어 있고, '합계에 포함' 열을 더하면 화면의 합계와 같습니다."),
      h("div", { class: "row" }, download("summary", "요약"), download("offerings", "헌금 내역"), download("expenses", "지출 내역"))),
  );
  await act(null, load);
}

// ---------- routing ----------

const routes = { entry: renderEntry, offerings: renderOfferings, expenses: renderExpenses, registry: renderRegistry, settings: renderSettings, reports: renderReports, audit: renderAudit };
const roleText = () => `${state.me.name} · ${isEditor() ? "재정 기록" : "재정 열람"}${isRegistryAdmin() ? " · 교적부 관리" : ""}`;

async function route() {
  const tab = currentTab();
  const tabOf = tab === "audit" ? "reports" : tab; // 변경 기록 lives under the 보고·기록 tab
  for (const a of document.querySelectorAll(".tabs a")) a.classList.toggle("on", a.dataset.tab === tabOf);
  view.replaceChildren(h("p", { class: "muted" }, "불러오는 중…"));
  const ticketBefore = renderTicket;
  try {
    await routes[tab]();
  } catch (err) {
    // Only if no newer screen has started since (the user may have moved on).
    if (renderTicket === ticketBefore + 1) view.replaceChildren(h("p", { class: "notice" }, err.message));
  }
}

async function start() {
  try {
    [state.me, state.settings] = await Promise.all([api("GET", "/api/me"), api("GET", "/api/settings")]);
  } catch (err) {
    view.replaceChildren(h("h2", {}, "로그인할 수 없습니다"), h("p", { class: "notice" }, err.message));
    return;
  }
  document.body.classList.toggle("viewer", !isEditor());
  document.querySelector('.tabs a[data-tab="entry"]').hidden = !isEditor(); // nothing to do there for a viewer
  document.body.classList.toggle("no-registry", !isRegistryAdmin());
  document.getElementById("church-name").textContent = state.settings.church_name || "교회 회계";
  document.title = `${state.settings.church_name || "교회"} 회계`;
  document.getElementById("who").textContent = roleText();
  window.addEventListener("hashchange", route);
  route();
  remindDue();
}

start();
