import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import { todayInHobart } from "../dates";
import { addDays, describeRule, occurrences, weekdaysInMonth, type Rule } from "../schedule";
import type { AppEnv, AppUser } from "../types";
import { isRealDate, isUniqueViolation, isoDate, name, optionalText, parseBody, reason } from "../validation";

const positiveCents = z.number().int("센트 단위 정수여야 합니다.").positive("금액은 0보다 커야 합니다.").max(1_000_000_000);
const optionalId = z.number().int().positive().nullable().optional();

// ---------- 고정 지출 (rules) ----------

interface RecurringRow extends Rule {
  id: number;
  name: string;
  vendor: string | null;
  amount_cents: number;
  account: "cash" | "bank";
  department_id: number | null;
  category_id: number | null;
  note: string | null;
  is_active: number;
  generate_from: string | null;
  amount_mode: "fixed" | "per_week";
}

/** Amount for one payment date: fixed, or weekly amount × that weekday's count in the month. */
export function amountFor(r: Pick<RecurringRow, "amount_mode" | "amount_cents" | "weekday">, date: string) {
  if (r.amount_mode !== "per_week" || r.weekday == null) return { cents: r.amount_cents, weeks: null as number | null };
  const weeks = weekdaysInMonth(date, r.weekday);
  return { cents: r.amount_cents * weeks, weeks };
}

const ruleFields = {
  rule: z.enum(["monthly_day", "monthly_weekday", "weekly", "fortnightly"]),
  day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  nth: z.number().int().min(1).max(5).nullable().optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  anchor_date: isoDate.nullable().optional(),
};

/** Each rule needs exactly its own fields. */
function checkRule(v: { rule: string; day_of_month?: number | null; nth?: number | null; weekday?: number | null; anchor_date?: string | null }) {
  if (v.rule === "monthly_day") return v.day_of_month != null;
  if (v.rule === "monthly_weekday") return v.nth != null && v.weekday != null;
  if (v.rule === "weekly") return v.weekday != null;
  return v.anchor_date != null;
}
const RULE_MSG = "주기에 필요한 값(날짜·몇째 주·요일·기준일)을 입력하세요.";

const recurringCreate = z
  .object({
    name,
    vendor: optionalText(100),
    amount_cents: positiveCents,
    amount_mode: z.enum(["fixed", "per_week"]).optional(),
    account: z.enum(["cash", "bank"]),
    department_id: optionalId,
    category_id: optionalId,
    ...ruleFields,
    start_date: isoDate,
    end_date: isoDate.nullable().optional(),
    note: optionalText(300),
  })
  .strict()
  .refine(checkRule, RULE_MSG)
  .refine((v) => v.amount_mode !== "per_week" || v.rule === "monthly_weekday", "'주 단위 금액'은 '매월 몇째 주 무슨 요일' 주기에서만 쓸 수 있습니다.")
  .refine((v) => !v.end_date || v.end_date >= v.start_date, "종료일이 시작일보다 빠릅니다.");

const recurringUpdate = z
  .object({
    name: name.optional(),
    vendor: optionalText(100),
    amount_cents: positiveCents.optional(),
    account: z.enum(["cash", "bank"]).optional(),
    end_date: isoDate.nullable().optional(),
    note: optionalText(300),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "바꿀 내용을 입력하세요.");

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
const recurringOut = (r: RecurringRow) => ({
  ...r,
  is_active: r.is_active === 1,
  schedule: describeRule(r),
  amount_text: r.amount_mode === "per_week" ? `주 ${(r.amount_cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" })} × 그달 ${WEEKDAY_KO[r.weekday ?? 0]}요일 수` : null,
});

export const recurringRoutes = new Hono<AppEnv>();

recurringRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM recurring_expenses ORDER BY is_active DESC, name, id").all<RecurringRow>();
  return c.json(results.map(recurringOut));
});

recurringRoutes.post("/", async (c) => {
  const b = await parseBody(c, recurringCreate);
  const db = c.env.DB;
  const user = c.get("user");
  const row = {
    name: b.name, vendor: b.vendor ?? null, amount_cents: b.amount_cents, amount_mode: b.amount_mode ?? "fixed", account: b.account,
    department_id: b.department_id ?? null, category_id: b.category_id ?? null, rule: b.rule,
    day_of_month: b.rule === "monthly_day" ? b.day_of_month! : null,
    nth: b.rule === "monthly_weekday" ? b.nth! : null,
    weekday: b.rule === "monthly_weekday" || b.rule === "weekly" ? b.weekday! : null,
    anchor_date: b.rule === "fortnightly" ? b.anchor_date! : null,
    start_date: b.start_date, end_date: b.end_date ?? null, note: b.note ?? null,
  };
  try {
    const [, created] = await db.batch([
      db
        .prepare(
          `INSERT INTO recurring_expenses (name, vendor, amount_cents, amount_mode, account, department_id, category_id, rule, day_of_month,
             nth, weekday, anchor_date, start_date, end_date, note, generate_from, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(row.name, row.vendor, row.amount_cents, row.amount_mode, row.account, row.department_id, row.category_id, row.rule,
          row.day_of_month, row.nth, row.weekday, row.anchor_date, row.start_date, row.end_date, row.note,
          // Never back-fill before today: earlier payments were made outside the app.
          todayInHobart(), user.id),
      db.prepare("SELECT * FROM recurring_expenses WHERE id = last_insert_rowid()"),
      auditStatement(db, user, "create", "recurring_expenses", "last_insert", undefined, row),
    ]);
    return c.json(recurringOut(created!.results[0] as RecurringRow), 201);
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) throw new HTTPException(400, { message: "없는 부서 또는 지출 항목입니다." });
    throw err;
  }
});

recurringRoutes.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, recurringUpdate);
  const db = c.env.DB;
  const before = await db.prepare("SELECT * FROM recurring_expenses WHERE id = ?").bind(id).first<RecurringRow>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  const next = {
    name: b.name ?? before.name,
    vendor: b.vendor === undefined ? before.vendor : b.vendor,
    amount_cents: b.amount_cents ?? before.amount_cents,
    account: b.account ?? before.account,
    end_date: b.end_date === undefined ? before.end_date ?? null : b.end_date,
    note: b.note === undefined ? before.note : b.note,
    is_active: b.is_active === undefined ? before.is_active : b.is_active ? 1 : 0,
  };
  if (next.end_date && next.end_date < before.start_date) throw new HTTPException(400, { message: "종료일이 시작일보다 빠릅니다." });
  const unchanged = (Object.keys(next) as (keyof typeof next)[]).every((k) => (before[k as keyof RecurringRow] ?? null) === (next[k] ?? null));
  if (unchanged) return c.json(recurringOut(before));
  const today = todayInHobart();
  const restarted = before.is_active === 0 && next.is_active === 1;
  // Restarting doesn't back-fill the paused weeks.
  const generateFrom = restarted ? today : before.generate_from;
  const user = c.get("user");
  const statements = [
    // Guarded on the values read, so a concurrent edit to the same rule is not silently lost.
    db
      .prepare(
        `UPDATE recurring_expenses SET name = ?, vendor = ?, amount_cents = ?, account = ?, end_date = ?, note = ?, is_active = ?, generate_from = ?
         WHERE id = ? AND name = ? AND vendor IS ? AND amount_cents = ? AND account = ? AND end_date IS ? AND note IS ? AND is_active = ?`,
      )
      .bind(next.name, next.vendor, next.amount_cents, next.account, next.end_date, next.note, next.is_active, generateFrom,
        id, before.name, before.vendor, before.amount_cents, before.account, before.end_date ?? null, before.note, before.is_active),
    auditStatement(db, user, "update", "recurring_expenses", id, before, { ...next, generate_from: generateFrom }, true),
  ];
  // Stopped: unpaid planned rows from today on are cancelled (overdue ones stay — that money is still owed).
  // Ended earlier: planned rows after the end date are cancelled. Each cancellation is audited, and
  // marked as automatic so restarting / extending can bring the row back.
  const stopping = before.is_active === 1 && next.is_active === 0;
  const endMoved = next.end_date !== (before.end_date ?? null);
  const cutoff = stopping ? addDays(today, -1) : endMoved ? next.end_date : null;
  if (cutoff) {
    const reason = stopping ? `${AUTO_VOID}고정 지출 중지` : `${AUTO_VOID}고정 지출 종료일 이후`;
    const pred = "recurring_id = ? AND status = 'planned' AND scheduled_date > ?";
    statements.push(
      db
        .prepare(
          `INSERT INTO audit_log (user_id, user_email, action, table_name, row_id, before_json, after_json)
           SELECT ?, ?, 'void', 'expenses', id,
             json_object('status', status, 'expense_date', expense_date, 'total_cents', total_cents, 'vendor', vendor),
             json_object('status', 'void', 'void_reason', ?)
           FROM expenses WHERE ${pred}`,
        )
        .bind(user.id, user.email, reason, id, cutoff),
      db.prepare(`UPDATE expenses SET status = 'void', void_reason = ? WHERE ${pred}`).bind(reason, id, cutoff),
    );
  }
  const [u] = await db.batch(statements);
  if (u!.meta.changes === 0) throw new HTTPException(409, { message: "다른 사람이 먼저 고쳤습니다. 새로고침 후 다시 시도하세요." });
  return c.json(recurringOut({ ...before, ...next, generate_from: generateFrom }));
});

/** Prefix of void reasons written automatically (stop / earlier end date); such rows can come back. */
export const AUTO_VOID = "[자동] ";

/** Days ahead that fixed costs are put on the list (and shown in the reminder). */
export const LOOKAHEAD_DAYS = 7;
/**
 * How far back missed dates are filled in when nobody opened the app for a while (bounded so one
 * request stays small). Never earlier than the rule's generate_from (creation / restart date).
 */
const LOOKBACK_DAYS = 92;

/**
 * Puts upcoming fixed-cost dates onto the expense list as 'planned'. Idempotent: the unique
 * (recurring_id, expense_date) index means a date is added once, even if later skipped (void).
 * Called whenever someone opens the due list; no background timer is needed.
 */
export async function generatePlanned(db: D1Database, today = todayInHobart()): Promise<number> {
  const { results: rules } = await db.prepare("SELECT * FROM recurring_expenses WHERE is_active = 1").all<RecurringRow>();
  if (!rules.length) return 0;
  const system = await db
    .prepare("SELECT id, email, name, role FROM users WHERE email = 'scheduler@system.local'")
    .first<Omit<AppUser, "registry_admin">>();
  if (!system) throw new HTTPException(500, { message: "고정 지출 계정이 없습니다." });
  const actor: AppUser = { ...system, registry_admin: false };
  const windowFrom = addDays(today, -LOOKBACK_DAYS);
  const to = addDays(today, LOOKAHEAD_DAYS);
  // Dates already on the list (planned, paid or skipped) are left alone. Selecting them first keeps
  // the write batch to the genuinely new dates, so opening the app stays cheap as rules accumulate.
  const { results: existing } = await db
    .prepare("SELECT id, recurring_id, scheduled_date, status, void_reason FROM expenses WHERE recurring_id IS NOT NULL AND scheduled_date BETWEEN ? AND ?")
    .bind(windowFrom, to)
    .all<{ id: number; recurring_id: number; scheduled_date: string; status: string; void_reason: string | null }>();
  const have = new Map(existing.map((e) => [`${e.recurring_id}|${e.scheduled_date}`, e]));
  const statements: D1PreparedStatement[] = [];
  for (const r of rules) {
    const from = r.generate_from && r.generate_from > windowFrom ? r.generate_from : windowFrom;
    for (const d of occurrences(r, from, to)) {
      const prior = have.get(`${r.id}|${d}`);
      const { cents, weeks } = amountFor(r, d);
      if (prior) {
        // Cancelled automatically when the rule was stopped / shortened, and the rule now covers
        // this date again: bring it back. Anything else already there (paid, skipped by a person,
        // planned) is left alone.
        if (prior.status === "void" && prior.void_reason?.startsWith(AUTO_VOID)) {
          statements.push(
            db.prepare("UPDATE expenses SET status = 'planned', void_reason = NULL, total_cents = ? WHERE id = ? AND status = 'void'").bind(cents, prior.id),
            auditStatement(db, actor, "update", "expenses", prior.id, { status: "void", void_reason: prior.void_reason }, { status: "planned", total_cents: cents }, true),
          );
        }
        continue;
      }
      const row = { expense_date: d, vendor: r.vendor || r.name, total_cents: cents, account: r.account, recurring_id: r.id };
      const note = weeks ? `고정 지출: ${r.name} (주 ${(r.amount_cents / 100).toFixed(2)} × ${weeks}주)` : `고정 지출: ${r.name}`;
      // INSERT OR IGNORE: already there (planned, paid or skipped) -> nothing happens, and the
      // audit row below is only written when this insert actually added a row.
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO expenses (expense_date, scheduled_date, vendor, department_id, category_id, total_cents, account, note, status, recurring_id, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
          )
          .bind(d, d, row.vendor, r.department_id, r.category_id, cents, r.account, note, r.id, actor.id),
        auditStatement(db, actor, "create", "expenses", "last_insert", undefined, row, true),
      );
    }
  }
  if (!statements.length) return 0;
  const res = await db.batch(statements);
  return res.filter((_, i) => i % 2 === 0).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

// ---------- 지출 ----------

interface ExpenseRow {
  id: number;
  expense_date: string;
  vendor: string;
  total_cents: number;
  account: string;
  status: string;
  recurring_id: number | null;
  [k: string]: unknown;
}

const SELECT = `SELECT e.id, e.expense_date, e.vendor, e.department_id, d.name AS department_name, e.category_id,
  c.name AS category_name, e.total_cents, e.gst_cents, e.account, e.paid_by, e.note, e.status, e.void_reason,
  e.recurring_id, r.name AS recurring_name, e.scheduled_date, e.created_at
  FROM expenses e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN expense_categories c ON c.id = e.category_id
  LEFT JOIN recurring_expenses r ON r.id = e.recurring_id`;

const expenseCreate = z
  .object({
    expense_date: isoDate,
    vendor: z.string().transform((v) => v.normalize("NFC").trim()).pipe(z.string().min(1, "지급처/내용을 입력하세요.").max(100)),
    total_cents: positiveCents,
    gst_cents: z.number().int().min(0).optional(),
    account: z.enum(["cash", "bank"]),
    department_id: optionalId,
    category_id: optionalId,
    paid_by: optionalText(50),
    note: optionalText(300),
    client_key: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
  })
  .strict()
  .refine((v) => (v.gst_cents ?? 0) <= v.total_cents, "GST가 총액보다 클 수 없습니다.");

const paySchema = z
  .object({ total_cents: positiveCents.optional(), expense_date: isoDate.optional(), account: z.enum(["cash", "bank"]).optional(), note: optionalText(300) })
  .strict();

export const expenseRoutes = new Hono<AppEnv>();

expenseRoutes.get("/", async (c) => {
  const where: string[] = [];
  const binds: unknown[] = [];
  for (const [key, op] of [["from", ">="], ["to", "<="]] as const) {
    const v = c.req.query(key);
    if (!v) continue;
    if (!isRealDate(v)) throw new HTTPException(400, { message: `${key}: YYYY-MM-DD 형식이어야 합니다.` });
    where.push(`e.expense_date ${op} ?`);
    binds.push(v);
  }
  const dept = c.req.query("department_id");
  if (dept) {
    if (!/^[0-9]{1,15}$/.test(dept)) throw new HTTPException(400, { message: "department_id: 숫자여야 합니다." });
    where.push("e.department_id = ?");
    binds.push(Number(dept));
  }
  if (c.req.query("include_void") !== "1") where.push("e.status != 'void'");
  const { results } = await c.env.DB.prepare(
    `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.expense_date DESC, e.id DESC LIMIT 1000`,
  )
    .bind(...binds)
    .all<ExpenseRow>();
  return c.json(results);
});

/** Fixed costs due soon or overdue and not yet paid. Adds newly due dates first. */
expenseRoutes.get("/due", async (c) => {
  const today = todayInHobart();
  // Only finance editors' visits add rows; others just read what is there.
  if (c.get("user").role === "editor") await generatePlanned(c.env.DB, today);
  const { results } = await c.env.DB.prepare(`${SELECT} WHERE e.status = 'planned' AND e.expense_date <= ? ORDER BY e.expense_date, e.id`)
    .bind(addDays(today, LOOKAHEAD_DAYS))
    .all<ExpenseRow>();
  return c.json({ today, items: results.map((r) => ({ ...r, overdue: r.expense_date < today })) });
});

expenseRoutes.post("/", async (c) => {
  const b = await parseBody(c, expenseCreate);
  const db = c.env.DB;
  const user = c.get("user");
  const key = b.client_key ?? null;
  const existingByKey = async () => (key ? db.prepare(`${SELECT} WHERE e.client_key = ?`).bind(key).first() : null);
  const already = await existingByKey();
  if (already) return c.json(already, 200); // a resend of a form that was already saved
  const row = {
    expense_date: b.expense_date, vendor: b.vendor, total_cents: b.total_cents, gst_cents: b.gst_cents ?? 0, account: b.account,
    department_id: b.department_id ?? null, category_id: b.category_id ?? null, paid_by: b.paid_by ?? null, note: b.note ?? null,
  };
  try {
    const [, created] = await db.batch([
      db
        .prepare(
          `INSERT INTO expenses (expense_date, vendor, total_cents, gst_cents, account, department_id, category_id, paid_by, note, status, created_by, client_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
        )
        .bind(row.expense_date, row.vendor, row.total_cents, row.gst_cents, row.account, row.department_id, row.category_id, row.paid_by, row.note, user.id, key),
      db.prepare(`${SELECT} WHERE e.id = last_insert_rowid()`),
      auditStatement(db, user, "create", "expenses", "last_insert", undefined, row),
    ]);
    return c.json(created!.results[0], 201);
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) throw new HTTPException(400, { message: "없는 부서 또는 지출 항목입니다." });
    if (isUniqueViolation(err)) {
      const raced = await existingByKey();
      if (raced) return c.json(raced, 200);
    }
    throw err;
  }
});

/** Marks a planned fixed cost as paid (optionally with the actual amount/date/account). */
expenseRoutes.post("/:id{[0-9]+}/pay", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, paySchema);
  const db = c.env.DB;
  const before = await db.prepare(`${SELECT} WHERE e.id = ?`).bind(id).first<ExpenseRow>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  if (before.status !== "planned") throw new HTTPException(409, { message: "이미 처리된 항목입니다." });
  if (b.total_cents !== undefined && b.total_cents < (before.gst_cents as number)) {
    throw new HTTPException(400, { message: "지급 금액이 이 항목의 GST보다 작습니다. 먼저 '수정'에서 GST를 고치세요." });
  }
  const next = {
    status: "confirmed",
    total_cents: b.total_cents ?? before.total_cents,
    expense_date: b.expense_date ?? before.expense_date,
    account: b.account ?? before.account,
    note: b.note === undefined ? before.note : b.note,
  };
  try {
    const [u] = await db.batch([
      db
        .prepare(
          `UPDATE expenses SET status = 'confirmed', total_cents = ?, expense_date = ?, account = ?, note = ?
           WHERE id = ? AND status = 'planned' AND total_cents = ? AND expense_date = ? AND account = ? AND note IS ?`,
        )
        .bind(next.total_cents, next.expense_date, next.account, next.note, id, before.total_cents, before.expense_date, before.account, before.note),
      auditStatement(db, c.get("user"), "update", "expenses", id, before, next, true),
    ]);
    if (u!.meta.changes === 0) throw new HTTPException(409, { message: "이미 처리되었거나 다른 사람이 고쳤습니다. 새로고침하세요." });
  } catch (err) {
    throw err;
  }
  return c.json({ ...before, ...next });
});

expenseRoutes.post("/:id{[0-9]+}/void", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, z.object({ reason }).strict());
  const db = c.env.DB;
  const before = await db.prepare(`${SELECT} WHERE e.id = ?`).bind(id).first<ExpenseRow>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  const [u] = await db.batch([
    db.prepare("UPDATE expenses SET status = 'void', void_reason = ? WHERE id = ? AND status != 'void'").bind(b.reason, id),
    auditStatement(db, c.get("user"), "void", "expenses", id, before, { status: "void", void_reason: b.reason }, true),
  ]);
  if (u!.meta.changes === 0) throw new HTTPException(409, { message: "이미 취소된 항목입니다." });
  return c.json({ ok: true });
});

/** Totals for a period: paid (confirmed) and still planned, by account. */
expenseRoutes.get("/summary", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to || !isRealDate(from) || !isRealDate(to)) throw new HTTPException(400, { message: "from, to: YYYY-MM-DD" });
  const dept = c.req.query("department_id");
  if (dept && !/^[0-9]{1,15}$/.test(dept)) throw new HTTPException(400, { message: "department_id: 숫자여야 합니다." });
  const { results } = await c.env.DB.prepare(
    `SELECT status, account, SUM(total_cents) AS total_cents, COUNT(*) AS count FROM expenses
     WHERE expense_date BETWEEN ? AND ? AND status IN ('confirmed', 'planned') ${dept ? "AND department_id = ?" : ""}
     GROUP BY status, account`,
  )
    .bind(from, to, ...(dept ? [Number(dept)] : []))
    .all<{ status: string; account: string; total_cents: number; count: number }>();
  const sum = (status: string, account?: string) =>
    results.filter((r) => r.status === status && (!account || r.account === account)).reduce((s, r) => s + r.total_cents, 0);
  return c.json({
    paid_cents: sum("confirmed"), paid_cash_cents: sum("confirmed", "cash"), paid_bank_cents: sum("confirmed", "bank"),
    planned_cents: sum("planned"),
  });
});

/** Edits a paid or planned expense. Guarded on the values the editor saw (no silent overwrite). */
const expenseUpdate = z
  .object({
    expense_date: isoDate.optional(),
    vendor: z.string().transform((v) => v.normalize("NFC").trim()).pipe(z.string().min(1, "지급처/내용을 입력하세요.").max(100)).optional(),
    total_cents: positiveCents.optional(),
    gst_cents: z.number().int().min(0).optional(),
    account: z.enum(["cash", "bank"]).optional(),
    department_id: optionalId,
    category_id: optionalId,
    note: optionalText(300),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "바꿀 내용을 입력하세요.");

expenseRoutes.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, expenseUpdate);
  const db = c.env.DB;
  const before = await db
    .prepare("SELECT id, expense_date, vendor, total_cents, gst_cents, account, department_id, category_id, note, status FROM expenses WHERE id = ?")
    .bind(id)
    .first<Record<string, any>>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  if (before.status === "void") throw new HTTPException(409, { message: "취소된 지출은 고칠 수 없습니다." });
  const pick = (k: string) => ((b as Record<string, unknown>)[k] === undefined ? before[k] : (b as Record<string, unknown>)[k]);
  const next = {
    expense_date: pick("expense_date"), vendor: pick("vendor"), total_cents: pick("total_cents"), gst_cents: pick("gst_cents"),
    account: pick("account"), department_id: pick("department_id"), category_id: pick("category_id"), note: pick("note"),
  };
  if ((next.gst_cents as number) > (next.total_cents as number)) throw new HTTPException(400, { message: "GST가 총액보다 클 수 없습니다." });
  try {
    const [u] = await db.batch([
      db
        .prepare(
          `UPDATE expenses SET expense_date = ?, vendor = ?, total_cents = ?, gst_cents = ?, account = ?, department_id = ?, category_id = ?, note = ?
           WHERE id = ? AND status = ? AND expense_date = ? AND vendor = ? AND total_cents = ? AND gst_cents = ? AND account = ?
             AND department_id IS ? AND category_id IS ? AND note IS ?`,
        )
        .bind(next.expense_date, next.vendor, next.total_cents, next.gst_cents, next.account, next.department_id, next.category_id, next.note,
          id, before.status, before.expense_date, before.vendor, before.total_cents, before.gst_cents, before.account,
          before.department_id, before.category_id, before.note),
      auditStatement(db, c.get("user"), "update", "expenses", id, before, next, true),
    ]);
    if (u!.meta.changes === 0) throw new HTTPException(409, { message: "다른 사람이 먼저 고쳤습니다. 새로고침 후 다시 시도하세요." });
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) throw new HTTPException(400, { message: "없는 부서 또는 지출 항목입니다." });
    throw err;
  }
  return c.json({ id, ...next, status: before.status });
});
