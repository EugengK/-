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
  const s = String(text).replace(/[\s$]/g, "");
  const m = /^(-)?(\d{1,3}(?:,\d{3})+|\d{1,10})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m || (m[1] && !allowNegative)) return null;
  const cents = Number(m[2].replace(/,/g, "")) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function lastSunday() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return ymd(d);
}
function monthRange() {
  const d = new Date();
  return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
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
    throw new Error(err?.name === "TimeoutError" ? "서버가 응답하지 않습니다. 서버가 켜져 있는지 확인하세요." : "서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인하세요.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error(data?.error ?? `오류가 발생했습니다 (${res.status})`);
  return data;
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
  state.members = await api("GET", "/api/members");
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
    label: byName.get(m.name) > 1 ? `${m.name} (${m.current_title || m.relation || `#${m.id}`})` : m.name,
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
  const clientKey = crypto.randomUUID();
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
      if (!confirm(`${warn}${date.value} 헌금 ${entries.length}건, 합계 ${money(total)}을 저장할까요?`)) {
        if (anonymous.length) lines[anonymous[0]].focusGiver();
        return;
      }
      await api("POST", "/api/offerings", { offering_date: date.value, entries, client_key: clientKey });
      toast(`${date.value} 헌금 저장: ${entries.length}건, ${money(total)}`);
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

function voidOffering(btn, o, after) {
  const reason = prompt(`${o.offering_date} ${o.fund_type_name} ${money(o.amount_cents)}\n이 항목을 취소합니다. 취소 사유를 입력하세요.\n(잘못 입력했다면 취소 후 다시 입력하세요.)`);
  if (reason === null) return;
  act(btn, async () => {
    await api("POST", `/api/offerings/${o.id}/void`, { reason });
    toast("취소했습니다.");
    await after();
  });
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
                h("div", { class: "grow" }, h("b", {}, p.name), " ", h("span", { class: "muted" }, [p.relation, p.member_code].filter(Boolean).join(" · "))),
                h("div", { class: "row shrink" },
                  ...p.candidates.map((cand) =>
                    h("button", { type: "button", class: "secondary small", onclick: (e) => {
                      if (!confirm(`시트의 '${p.name}'(${p.member_code})을(를) 이미 등록된 '${cand.name}'${cand.note ? `(${cand.note})` : ""}과(와) 같은 분으로 연결할까요?`)) return;
                      act(e.currentTarget, async () => { await api("POST", `/api/registry/pending/${p.member_code}/link`, { member_id: cand.id }); toast("연결했습니다."); await Promise.all([load(), loadPending()]); });
                    } }, `같은 분${p.candidates.length > 1 ? ` (#${cand.id}${cand.note ? ` ${cand.note}` : ""})` : ""}`)),
                  h("button", { type: "button", class: "small", onclick: (e) => {
                    if (!confirm(`'${p.name}'을(를) 다른 분으로 새로 등록할까요?`)) return;
                    act(e.currentTarget, async () => { await api("POST", `/api/registry/pending/${p.member_code}/create`, {}); toast("새로 등록했습니다."); await Promise.all([load(), loadPending()]); });
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
    h("button", { type: "button", class: "danger small registry-only", onclick: (e) => {
      const reason = prompt(`${what}\n이 기록을 취소합니다. 사유를 입력하세요.`);
      if (reason === null) return;
      act(e.currentTarget, async () => { await api("POST", path, { reason }); toast("취소했습니다."); reload(); });
    } }, "취소");

  // 직분 추가
  const titleSel = h("select", { "aria-label": "직분" }, titles.filter((t) => t.is_active).map((t) => h("option", { value: t.id }, t.term_limited ? `${t.name} (1년 임기)` : t.name)));
  const tStart = h("input", { type: "date", value: `${thisYear()}-01-01`, "aria-label": "시작일" });
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
      await api("POST", `/api/registry/members/${id}/titles`, {
        title_id: Number(titleSel.value), start_date: tStart.value, end_date: tEnd.value || null, note: tNote.value || undefined,
      });
      toast("직분을 기록했습니다.");
      reload();
    });

  // 상태 추가
  const sSel = h("select", { "aria-label": "상태" }, Object.entries(STATUS_LABELS).filter(([k]) => k !== "registered").map(([k, v]) => h("option", { value: k }, v)));
  const sDate = h("input", { type: "date", value: ymd(new Date()), max: ymd(new Date()), "aria-label": "날짜" });
  const sNote = h("input", { placeholder: "메모 (선택)", maxlength: 300 });
  const sAdd = h("button", { type: "button" }, "상태 기록");
  sAdd.onclick = () =>
    act(sAdd, async () => {
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
        h("li", {}, h("span", {}, "생년월일"), h("b", {}, m.birth_date ? `${m.birth_date} (${ageOf(m.birth_date)}세)` : "-")),
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
  text = text.replace(/^\uFEFF/, "");
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
    if (birth && (birth < "1900-01-01" || birth > today || isNaN(Date.parse(birth)))) birth = null;
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

function importCard(after) {
  const file = h("input", { type: "file", accept: ".csv,text/csv", "aria-label": "CSV 파일" });
  const out = h("div", { class: "muted" });
  const go = h("button", { type: "button" }, "가져오기");
  go.onclick = () =>
    act(go, async () => {
      const f = file.files?.[0];
      if (!f) throw new Error("CSV 파일을 고르세요.");
      const { people, skipped, noBirth, used, ignored } = peopleFromCsv(await f.text());
      if (!people.length) throw new Error("가져올 사람이 없습니다.");
      if (!confirm(`${people.length}명을 교적부로 가져옵니다.\n읽는 칸 ${used}개, 읽지 않고 버리는 칸 ${ignored}개.\n계속할까요?`)) return;
      const total = { created: 0, updated: 0, pending: 0, unchanged: 0, unknown: new Set() };
      for (let i = 0; i < people.length; i += 100) {
        const r = await api("POST", "/api/registry/import", { people: people.slice(i, i + 100) });
        total.created += r.created; total.updated += r.updated; total.pending += r.pending; total.unchanged += r.unchanged;
        r.unknown_titles.forEach((t) => total.unknown.add(t));
      }
      out.replaceChildren(...[
        h("div", {}, `새로 등록 ${total.created}명 · 변경 ${total.updated}명 · 그대로 ${total.unchanged}명${total.pending ? ` · 확인 필요 ${total.pending}명` : ""}`),
        skipped.length ? h("div", {}, `형식이 맞지 않아 건너뛴 줄: ${skipped.join(", ")}`) : null,
        noBirth.length ? h("div", {}, `생년월일을 읽지 못한 줄 (나머지는 가져옴): ${noBirth.join(", ")}`) : null,
        total.unknown.size ? h("div", {}, `목록에 없는 직분이라 기록하지 않음: ${[...total.unknown].join(", ")}`) : null,
      ].filter(Boolean));
      file.value = "";
      toast("가져왔습니다.");
      await after();
    });
  return h("details", { class: "card registry-only" },
    h("summary", {}, h("b", {}, "목양 시트에서 가져오기 (CSV)")),
    h("p", { class: "muted mt" }, "시트의 '교인목록' 탭에서 [파일] → [다운로드] → [CSV]로 받은 파일을 고르세요. 교인ID·가정ID·이름·관계·생년월일·직분·등록일만 읽고, 메모·기도제목·주소 등 나머지 칸은 이 화면에서 버려져 서버로 가지 않습니다. 여러 번 가져와도 중복되지 않습니다."),
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
                h("button", { type: "button", class: "mini", title: "이름 변경", onclick: (e) => {
                  const name = prompt("새 이름", r.name);
                  if (name === null) return;
                  act(e.currentTarget, async () => { await api("PATCH", `${path}/${r.id}`, { name }); await load(); });
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
              h("div", { class: "shrink editor-only" }, h("button", { type: "button", class: "danger small", onclick: (e) => {
                const reason = prompt(`${label} 시작 잔액 ${money(cur.amount_cents)}을 취소합니다. 사유를 입력하세요.`);
                if (reason === null) return;
                act(e.currentTarget, async () => { await api("POST", `/api/opening-balances/${cur.id}/void`, { reason }); await load(); });
              } }, "취소"))));
        }
        const date = h("input", { type: "date", value: ymd(new Date()) });
        const amount = h("input", { inputmode: "decimal", placeholder: "0.00" });
        const note = h("input", { placeholder: "메모 (선택)", maxlength: 300 });
        const save = h("button", { type: "button" }, "저장");
        save.onclick = () =>
          act(save, async () => {
            const cents = toCents(amount.value, { allowNegative: true });
            if (cents === null) throw new Error("금액이 올바르지 않습니다. (예: 12500 또는 12500.50)");
            if (!confirm(`${label} 시작 잔액을 ${date.value} 기준 ${money(cents)}으로 저장할까요?`)) return;
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
  paint(ticket, h("h2", {}, "변경 기록"), h("p", { class: "muted" }, "누가, 언제, 무엇을 바꿨는지 모두 남습니다. 지울 수 없습니다."), h("div", { class: "card" }, list), more);
  await act(null, load);
}

// ---------- routing ----------

const routes = { entry: renderEntry, offerings: renderOfferings, registry: renderRegistry, settings: renderSettings, audit: renderAudit };
const roleText = () => `${state.me.name} · ${isEditor() ? "재정 기록" : "재정 열람"}${isRegistryAdmin() ? " · 교적부 관리" : ""}`;

async function route() {
  const tab = currentTab();
  for (const a of document.querySelectorAll(".tabs a")) a.classList.toggle("on", a.dataset.tab === tab);
  view.replaceChildren(h("p", { class: "muted" }, "불러오는 중…"));
  try {
    await routes[tab]();
  } catch (err) {
    view.replaceChildren(h("p", { class: "notice" }, err.message));
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
  document.body.classList.toggle("no-registry", !isRegistryAdmin());
  document.getElementById("church-name").textContent = state.settings.church_name || "교회 회계";
  document.title = `${state.settings.church_name || "교회"} 회계`;
  document.getElementById("who").textContent = roleText();
  window.addEventListener("hashchange", route);
  route();
}

start();
