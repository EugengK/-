import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { addDays } from "../schedule";
import type { AppEnv } from "../types";
import { isRealDate } from "../validation";

/**
 * Period report and CSV exports for quarterly checks in Excel / Numbers / Google Sheets.
 * Read-only: every logged-in user may use it (viewers included).
 *
 * Balances: each account (cash, bank) starts from its active opening balance, taken as the
 * balance at the start of its as-of date. Activity on or after that date moves it:
 * offerings (cash -> cash, online -> bank) in, paid expenses out. Planned and voided rows never count.
 */
export const reportRoutes = new Hono<AppEnv>();

function period(q: (k: string) => string | undefined) {
  const from = q("from");
  const to = q("to");
  if (!from || !to || !isRealDate(from) || !isRealDate(to)) throw new HTTPException(400, { message: "from, to: YYYY-MM-DD" });
  if (from > to) throw new HTTPException(400, { message: "시작일이 종료일보다 늦습니다." });
  return { from, to };
}

type Account = "cash" | "bank";
const ACCOUNTS: Account[] = ["cash", "bank"];

async function net(db: D1Database, account: Account, from: string, to: string): Promise<number> {
  const method = account === "cash" ? "cash" : "online";
  const [inc, out] = await db.batch([
    db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM offerings WHERE status = 'active' AND method = ? AND offering_date BETWEEN ? AND ?").bind(method, from, to),
    db.prepare("SELECT COALESCE(SUM(total_cents), 0) AS n FROM expenses WHERE status = 'confirmed' AND account = ? AND expense_date BETWEEN ? AND ?").bind(account, from, to),
  ]);
  return (inc!.results[0] as { n: number }).n - (out!.results[0] as { n: number }).n;
}

export async function buildSummary(db: D1Database, from: string, to: string) {
  const { results: obs } = await db
    .prepare("SELECT account, as_of_date, amount_cents FROM opening_balances WHERE status = 'active'")
    .all<{ account: Account; as_of_date: string; amount_cents: number }>();
  const notes: string[] = [];
  const balances = [];
  for (const account of ACCOUNTS) {
    const ob = obs.find((o) => o.account === account);
    if (!ob) {
      balances.push({ account, opening: null, as_of_date: null, start_cents: null, end_cents: null });
      continue;
    }
    // Before the opening date there is no known balance, so a period starting earlier has no start
    // balance (showing the opening amount there would not add up with the period's income/expenses).
    const start = from < ob.as_of_date ? null
      : from === ob.as_of_date ? ob.amount_cents
      : ob.amount_cents + (await net(db, account, ob.as_of_date, addDays(from, -1)));
    const end = to < ob.as_of_date ? null : ob.amount_cents + (await net(db, account, ob.as_of_date, to));
    if (from < ob.as_of_date) {
      const label = account === "cash" ? "현금" : "은행";
      notes.push(`${label}: 시작 잔액 기준일(${ob.as_of_date}, $${(ob.amount_cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})보다 앞선 기간이 들어 있어 기간 시작 잔액을 계산할 수 없습니다. 기준일부터 고르시면 잔액이 맞게 나옵니다.`);
    }
    balances.push({ account, opening: ob.amount_cents, as_of_date: ob.as_of_date, start_cents: start, end_cents: end });
  }
  if (balances.some((b) => b.opening === null)) notes.push("시작 잔액이 입력되지 않은 계정은 잔액을 계산하지 않습니다 (설정 → 시작 잔액).");

  const [byFund, byDept, byCat, byAccount, planned] = await db.batch([
    db.prepare(
      `SELECT f.name AS name, o.method AS method, SUM(o.amount_cents) AS total_cents, COUNT(*) AS count
       FROM offerings o JOIN fund_types f ON f.id = o.fund_type_id
       WHERE o.status = 'active' AND o.offering_date BETWEEN ? AND ? GROUP BY o.fund_type_id, o.method ORDER BY f.sort_order, f.id, o.method`,
    ).bind(from, to),
    db.prepare(
      `SELECT COALESCE(d.name, '(부서 없음)') AS name, SUM(e.total_cents) AS total_cents, COUNT(*) AS count
       FROM expenses e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.status = 'confirmed' AND e.expense_date BETWEEN ? AND ? GROUP BY e.department_id ORDER BY d.sort_order IS NULL, d.sort_order, d.id`,
    ).bind(from, to),
    db.prepare(
      `SELECT COALESCE(c.name, '(항목 없음)') AS name, SUM(e.total_cents) AS total_cents, COUNT(*) AS count
       FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id
       WHERE e.status = 'confirmed' AND e.expense_date BETWEEN ? AND ? GROUP BY e.category_id ORDER BY c.sort_order IS NULL, c.sort_order, c.id`,
    ).bind(from, to),
    db.prepare(
      `SELECT account, SUM(total_cents) AS total_cents, SUM(gst_cents) AS gst_cents FROM expenses
       WHERE status = 'confirmed' AND expense_date BETWEEN ? AND ? GROUP BY account`,
    ).bind(from, to),
    db.prepare(
      `SELECT COALESCE(SUM(total_cents), 0) AS total_cents, COUNT(*) AS count FROM expenses
       WHERE status = 'planned' AND expense_date BETWEEN ? AND ?`,
    ).bind(from, to),
  ]);
  const income = byFund!.results as { name: string; method: string; total_cents: number; count: number }[];
  const expAcc = byAccount!.results as { account: string; total_cents: number; gst_cents: number }[];
  const sum = (rows: { total_cents: number }[]) => rows.reduce((n, r) => n + r.total_cents, 0);
  return {
    from, to,
    balances,
    income: {
      rows: income,
      cash_cents: sum(income.filter((r) => r.method === "cash")),
      online_cents: sum(income.filter((r) => r.method === "online")),
      total_cents: sum(income),
    },
    expenses: {
      by_department: byDept!.results,
      by_category: byCat!.results,
      cash_cents: sum(expAcc.filter((r) => r.account === "cash")),
      bank_cents: sum(expAcc.filter((r) => r.account === "bank")),
      gst_cents: expAcc.reduce((n, r) => n + r.gst_cents, 0),
      total_cents: sum(expAcc),
    },
    planned_unpaid: planned!.results[0],
    notes,
  };
}

reportRoutes.get("/summary", async (c) => {
  const { from, to } = period((k) => c.req.query(k));
  return c.json(await buildSummary(c.env.DB, from, to));
});

// ---------- CSV ----------

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @, tab, CR) is prefixed
 * with ' so a name like "=HYPERLINK(...)" stays plain text. Numbers are written as numbers.
 */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const dollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : Number((cents / 100).toFixed(2)));

function csv(name: string, rows: unknown[][]) {
  // BOM so Excel opens Korean text as UTF-8; CRLF line ends for Excel on Windows.
  const body = "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      // ASCII names: some browsers drop non-ASCII download names and save the file as "download".
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}

const METHOD: Record<string, string> = { cash: "현금", online: "온라인" };
const ACCOUNT: Record<string, string> = { cash: "현금", bank: "은행" };
const EXP_STATUS: Record<string, string> = { confirmed: "지급", planned: "예정(미지급)", draft: "확인 전", void: "취소" };

reportRoutes.get("/offerings.csv", async (c) => {
  const { from, to } = period((k) => c.req.query(k));
  const { results } = await c.env.DB.prepare(
    `SELECT o.offering_date, f.name AS fund, o.method, m.name AS member, m.member_code, o.visitor_name, o.visitor_from,
            o.amount_cents, o.status, o.void_reason, o.note, o.created_at
     FROM offerings o JOIN fund_types f ON f.id = o.fund_type_id LEFT JOIN members m ON m.id = o.member_id
     WHERE o.offering_date BETWEEN ? AND ? ORDER BY o.offering_date, o.id`,
  )
    .bind(from, to)
    .all<Record<string, any>>();
  return csv(`offerings_${from}_${to}.csv`, [
    ["날짜", "헌금 종류", "방식", "구분", "성도", "교인ID", "방문자 출신", "금액(AUD)", "합계에 포함", "상태", "취소 사유", "메모", "입력 시각(UTC)"],
    ...results.map((r) => [
      r.offering_date, r.fund, METHOD[r.method] ?? r.method,
      r.member ? "교인" : r.visitor_name || r.visitor_from ? "방문자" : "무기명",
      r.member ?? r.visitor_name ?? "(무기명)", r.member_code, r.visitor_from, dollars(r.amount_cents),
      r.status === "active" ? dollars(r.amount_cents) : 0, r.status === "active" ? "정상" : "취소", r.void_reason, r.note, r.created_at,
    ]),
  ]);
});

reportRoutes.get("/expenses.csv", async (c) => {
  const { from, to } = period((k) => c.req.query(k));
  const { results } = await c.env.DB.prepare(
    `SELECT e.expense_date, e.scheduled_date, e.vendor, r.name AS recurring, d.name AS dept, cat.name AS category, e.account,
            e.total_cents, e.gst_cents, e.status, e.void_reason, e.note, e.created_at
     FROM expenses e LEFT JOIN recurring_expenses r ON r.id = e.recurring_id LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN expense_categories cat ON cat.id = e.category_id
     WHERE e.expense_date BETWEEN ? AND ? ORDER BY e.expense_date, e.id`,
  )
    .bind(from, to)
    .all<Record<string, any>>();
  return csv(`expenses_${from}_${to}.csv`, [
    ["날짜", "고정지출 예정일", "지급처/내용", "고정 지출", "부서", "지출 항목", "계정", "금액(AUD)", "GST(AUD)", "합계에 포함", "상태", "취소 사유", "메모", "입력 시각(UTC)"],
    ...results.map((r) => [
      r.expense_date, r.scheduled_date, r.vendor, r.recurring, r.dept, r.category, ACCOUNT[r.account] ?? r.account,
      dollars(r.total_cents), dollars(r.gst_cents), r.status === "confirmed" ? dollars(r.total_cents) : 0,
      EXP_STATUS[r.status] ?? r.status, r.void_reason, r.note, r.created_at,
    ]),
  ]);
});

reportRoutes.get("/summary.csv", async (c) => {
  const { from, to } = period((k) => c.req.query(k));
  const s = await buildSummary(c.env.DB, from, to);
  const rows: unknown[][] = [["구분", "항목", "현금(AUD)", "온라인·은행(AUD)", "합계(AUD)"]];
  rows.push(["기간", `${from} ~ ${to}`]);
  const bal = (a: Account) => s.balances.find((b) => b.account === a)!;
  const both = (x: number | null, y: number | null) => (x === null || y === null ? null : x + y);
  rows.push(["잔액", "기간 시작", dollars(bal("cash").start_cents), dollars(bal("bank").start_cents), dollars(both(bal("cash").start_cents, bal("bank").start_cents))]);
  for (const r of s.income.rows) rows.push(["수입", `${r.name} (${r.count}건)`, r.method === "cash" ? dollars(r.total_cents) : null, r.method === "online" ? dollars(r.total_cents) : null, dollars(r.total_cents)]);
  rows.push(["수입", "수입 합계", dollars(s.income.cash_cents), dollars(s.income.online_cents), dollars(s.income.total_cents)]);
  for (const r of s.expenses.by_department as any[]) rows.push(["지출(부서별)", `${r.name} (${r.count}건)`, null, null, dollars(r.total_cents)]);
  for (const r of s.expenses.by_category as any[]) rows.push(["지출(항목별)", `${r.name} (${r.count}건)`, null, null, dollars(r.total_cents)]);
  rows.push(["지출", "지출 합계", dollars(s.expenses.cash_cents), dollars(s.expenses.bank_cents), dollars(s.expenses.total_cents)]);
  rows.push(["지출", "그중 GST", null, null, dollars(s.expenses.gst_cents)]);
  rows.push(["잔액", "기간 끝", dollars(bal("cash").end_cents), dollars(bal("bank").end_cents), dollars(both(bal("cash").end_cents, bal("bank").end_cents))]);
  rows.push(["참고", `아직 지급하지 않은 고정 지출 (${(s.planned_unpaid as any).count}건)`, null, null, dollars((s.planned_unpaid as any).total_cents)]);
  for (const n of s.notes) rows.push(["참고", n]);
  return csv(`summary_${from}_${to}.csv`, rows);
});
