import { beforeEach, describe, expect, it } from "vitest";
import { todayInHobart } from "../src/dates";
import { generatePlanned } from "../src/routes/expenses";
import { addDays, describeRule, occurrences } from "../src/schedule";
import { EDITOR, EDITOR2, PASTOR, call, db, json, resetDb } from "./helpers";

const count = async (sql: string, ...b: unknown[]) =>
  (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;

describe("schedule rules", () => {
  it("first Sunday of each month", () => {
    const r = { rule: "monthly_weekday" as const, nth: 1, weekday: 0, start_date: "2026-01-01" };
    expect(occurrences(r, "2026-10-01", "2027-01-31")).toEqual(["2026-10-04", "2026-11-01", "2026-12-06", "2027-01-03"]);
    expect(describeRule(r)).toBe("매월 첫째 주 일요일");
  });
  it("last Friday; day 31 = last day of month; weekly; fortnightly from an anchor", () => {
    expect(occurrences({ rule: "monthly_weekday", nth: 5, weekday: 5, start_date: "2026-01-01" }, "2026-02-01", "2026-03-31")).toEqual(["2026-02-27", "2026-03-27"]);
    expect(occurrences({ rule: "monthly_day", day_of_month: 31, start_date: "2026-01-01" }, "2026-02-01", "2026-04-30")).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(occurrences({ rule: "monthly_day", day_of_month: 15, start_date: "2026-01-01" }, "2026-02-01", "2026-03-31")).toEqual(["2026-02-15", "2026-03-15"]);
    expect(occurrences({ rule: "weekly", weekday: 1, start_date: "2026-11-01" }, "2026-10-26", "2026-11-16")).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(occurrences({ rule: "fortnightly", anchor_date: "2026-11-06", start_date: "2026-10-01" }, "2026-10-20", "2026-11-30")).toEqual(["2026-10-23", "2026-11-06", "2026-11-20"]);
  });
  it("leap year February", () => {
    expect(occurrences({ rule: "monthly_day", day_of_month: 30, start_date: "2028-01-01" }, "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
  });
  it("respects start and end dates", () => {
    expect(occurrences({ rule: "weekly", weekday: 0, start_date: "2026-11-08", end_date: "2026-11-22" }, "2026-11-01", "2026-12-31")).toEqual(["2026-11-08", "2026-11-15", "2026-11-22"]);
  });
});

describe("fixed costs (고정 지출)", () => {
  beforeEach(resetDb);
  const today = todayInHobart();
  const stipend = { name: "담임목사 사례비", amount_cents: 500000, account: "bank", rule: "monthly_weekday", nth: 1, weekday: 0, start_date: addDays(today, -40) };
  const weeklyRent = { name: "예배당 렌트비", vendor: "St Mark's", amount_cents: 15000, account: "bank", rule: "weekly", weekday: new Date(`${addDays(today, 2)}T00:00:00Z`).getUTCDay(), start_date: today };

  it("editors create rules; validation per rule; pastor/viewer cannot", async () => {
    expect((await call("POST", "/api/recurring-expenses", { as: PASTOR, body: stipend })).status).toBe(403);
    const r = await call("POST", "/api/recurring-expenses", { as: EDITOR, body: stipend });
    expect(r.status).toBe(201);
    expect((await json(r)).schedule).toBe("매월 첫째 주 일요일");
    for (const bad of [
      { ...stipend, nth: undefined },
      { ...stipend, rule: "monthly_day" },
      { ...stipend, rule: "fortnightly" },
      { ...stipend, amount_cents: 0 },
      { ...stipend, end_date: "2000-01-01" },
      { ...stipend, extra: 1 },
    ]) {
      expect((await call("POST", "/api/recurring-expenses", { as: EDITOR, body: bad })).status).toBe(400);
    }
  });

  it("puts due dates on the list as 'planned', once only, and reports them as due", async () => {
    await call("POST", "/api/recurring-expenses", { as: EDITOR, body: weeklyRent });
    const due1 = await json(await call("GET", "/api/expenses/due", { as: EDITOR }));
    expect(due1.items).toHaveLength(1);
    expect(due1.items[0]).toMatchObject({ vendor: "St Mark's", total_cents: 15000, status: "planned", recurring_name: "예배당 렌트비", overdue: false });
    await call("GET", "/api/expenses/due", { as: EDITOR });
    await call("GET", "/api/expenses/due", { as: EDITOR2 });
    expect(await count("SELECT COUNT(*) AS n FROM expenses")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE user_email = 'scheduler@system.local'")).toBe(1);
    // The pastor's visit only reads.
    expect((await json(await call("GET", "/api/expenses/due", { as: PASTOR }))).items).toHaveLength(1);
  });

  it("never back-fills dates before the rule was added (earlier payments happened outside the app)", async () => {
    await call("POST", "/api/recurring-expenses", { as: EDITOR, body: stipend }); // start date 40 days ago
    const due = await json(await call("GET", "/api/expenses/due", { as: EDITOR }));
    expect(due.items.every((i: any) => i.expense_date >= today && !i.overdue)).toBe(true);
  });

  it("dates missed while nobody opened the app (since the rule was added) do show as overdue", async () => {
    const rule = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body: { ...weeklyRent, start_date: addDays(today, -30) } }));
    await db.prepare("UPDATE recurring_expenses SET generate_from = ? WHERE id = ?").bind(addDays(today, -20), rule.id).run();
    const due = await json(await call("GET", "/api/expenses/due", { as: EDITOR }));
    expect(due.items.some((i: any) => i.overdue)).toBe(true);
    expect(due.items.every((i: any) => i.expense_date >= addDays(today, -20))).toBe(true);
  });

  it("pay: planned -> confirmed with the actual amount; cannot pay twice; viewer cannot pay", async () => {
    await call("POST", "/api/recurring-expenses", { as: EDITOR, body: weeklyRent });
    const [item] = (await json(await call("GET", "/api/expenses/due", { as: EDITOR }))).items;
    expect((await call("POST", `/api/expenses/${item.id}/pay`, { as: PASTOR, body: {} })).status).toBe(403);
    const paid = await call("POST", `/api/expenses/${item.id}/pay`, { as: EDITOR, body: { total_cents: 15500 } });
    expect(paid.status).toBe(200);
    expect(await json(paid)).toMatchObject({ status: "confirmed", total_cents: 15500 });
    expect((await call("POST", `/api/expenses/${item.id}/pay`, { as: EDITOR, body: {} })).status).toBe(409);
    expect((await json(await call("GET", "/api/expenses/due", { as: EDITOR }))).items).toHaveLength(0);
  });

  it("skip (void) is remembered: the same date is not generated again", async () => {
    await call("POST", "/api/recurring-expenses", { as: EDITOR, body: weeklyRent });
    const [item] = (await json(await call("GET", "/api/expenses/due", { as: EDITOR }))).items;
    expect((await call("POST", `/api/expenses/${item.id}/void`, { as: EDITOR, body: { reason: "이번 주 면제" } })).status).toBe(200);
    expect(await generatePlanned(db)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM expenses")).toBe(1);
  });

  it("paying on a different day never brings the scheduled date back", async () => {
    await call("POST", "/api/recurring-expenses", { as: EDITOR, body: weeklyRent });
    const [item] = (await json(await call("GET", "/api/expenses/due", { as: EDITOR }))).items;
    await call("POST", `/api/expenses/${item.id}/pay`, { as: EDITOR, body: { expense_date: today } });
    expect(await generatePlanned(db)).toBe(0);
    expect((await json(await call("GET", "/api/expenses/due", { as: EDITOR }))).items).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM expenses")).toBe(1);
  });

  it("a skipped row cannot be paid", async () => {
    await call("POST", "/api/recurring-expenses", { as: EDITOR, body: weeklyRent });
    const [item] = (await json(await call("GET", "/api/expenses/due", { as: EDITOR }))).items;
    await call("POST", `/api/expenses/${item.id}/void`, { as: EDITOR, body: { reason: "x" } });
    expect((await call("POST", `/api/expenses/${item.id}/pay`, { as: EDITOR, body: {} })).status).toBe(409);
  });

  it("stopping a rule cancels its unpaid planned rows; restarting does not back-fill the pause", async () => {
    const rule = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body: weeklyRent }));
    await call("GET", "/api/expenses/due", { as: EDITOR });
    await call("PATCH", `/api/recurring-expenses/${rule.id}`, { as: EDITOR, body: { is_active: false } });
    expect((await json(await call("GET", "/api/expenses/due", { as: EDITOR }))).items).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM expenses WHERE status = 'void' AND void_reason LIKE '%중지%'")).toBe(1);
    // Pretend it was paused for three weeks, then switched back on.
    await db.prepare("UPDATE recurring_expenses SET generate_from = ? WHERE id = ?").bind(addDays(today, -21), rule.id).run();
    await call("PATCH", `/api/recurring-expenses/${rule.id}`, { as: EDITOR, body: { is_active: true } });
    const due = await json(await call("GET", "/api/expenses/due", { as: EDITOR }));
    expect(due.items.every((i: any) => i.expense_date >= today)).toBe(true);
  });

  it("an earlier end date cancels planned rows after it", async () => {
    const rule = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body: { ...weeklyRent, rule: "weekly", weekday: new Date(`${today}T00:00:00Z`).getUTCDay() } }));
    await call("GET", "/api/expenses/due", { as: EDITOR }); // today and today+7
    expect(await count("SELECT COUNT(*) AS n FROM expenses WHERE status = 'planned'")).toBe(2);
    await call("PATCH", `/api/recurring-expenses/${rule.id}`, { as: EDITOR, body: { end_date: today } });
    expect(await count("SELECT COUNT(*) AS n FROM expenses WHERE status = 'planned'")).toBe(1);
  });

  it("summary keeps paid and planned apart", async () => {
    await call("POST", "/api/recurring-expenses", { as: EDITOR, body: weeklyRent });
    const [item] = (await json(await call("GET", "/api/expenses/due", { as: EDITOR }))).items;
    const s = await json(await call("GET", `/api/expenses/summary?from=${addDays(today, -1)}&to=${addDays(today, 8)}`, { as: PASTOR }));
    expect(s).toMatchObject({ paid_cents: 0, planned_cents: 15000 });
    await call("POST", `/api/expenses/${item.id}/pay`, { as: EDITOR, body: {} });
    expect(await json(await call("GET", `/api/expenses/summary?from=${addDays(today, -1)}&to=${addDays(today, 8)}`, { as: PASTOR }))).toMatchObject({ paid_cents: 15000, planned_cents: 0 });
  });
});

describe("expenses", () => {
  beforeEach(resetDb);

  it("manual entry, list, summary, void", async () => {
    const e = await call("POST", "/api/expenses", { as: EDITOR, body: { expense_date: "2026-11-01", vendor: "Coles", total_cents: 4550, gst_cents: 200, account: "cash" } });
    expect(e.status).toBe(201);
    const row = await json(e);
    expect(row).toMatchObject({ status: "confirmed", department_id: null });
    await call("POST", "/api/expenses", { as: EDITOR, body: { expense_date: "2026-11-02", vendor: "Bank fee", total_cents: 500, account: "bank" } });
    const s = await json(await call("GET", "/api/expenses/summary?from=2026-11-01&to=2026-11-30", { as: PASTOR }));
    expect(s).toMatchObject({ paid_cents: 5050, paid_cash_cents: 4550, paid_bank_cents: 500, planned_cents: 0 });
    await call("POST", `/api/expenses/${row.id}/void`, { as: EDITOR, body: { reason: "중복" } });
    expect(await json(await call("GET", "/api/expenses?from=2026-11-01&to=2026-11-30", { as: PASTOR }))).toHaveLength(1);
    expect((await json(await call("GET", "/api/expenses/summary?from=2026-11-01&to=2026-11-30", { as: PASTOR }))).paid_cents).toBe(500);
  });

  it("validates", async () => {
    const ok = { expense_date: "2026-11-01", vendor: "x", total_cents: 100, account: "cash" };
    for (const bad of [{ ...ok, total_cents: 0 }, { ...ok, gst_cents: 200 }, { ...ok, account: "card" }, { ...ok, vendor: " " }, { ...ok, department_id: 999 }]) {
      expect((await call("POST", "/api/expenses", { as: EDITOR, body: bad })).status).toBe(400);
    }
    expect((await call("POST", "/api/expenses", { as: PASTOR, body: ok })).status).toBe(403);
  });
});

describe("weekly stipend paid monthly, and editing expenses", () => {
  beforeEach(resetDb);

  it("counts Sundays in the month", async () => {
    const { weekdaysInMonth } = await import("../src/schedule");
    expect(weekdaysInMonth("2026-11-01", 0)).toBe(5); // 1, 8, 15, 22, 29
    expect(weekdaysInMonth("2026-12-06", 0)).toBe(4);
    expect(weekdaysInMonth("2026-02-01", 0)).toBe(4);
    expect(weekdaysInMonth("2028-02-06", 2)).toBe(5); // leap Feb 2028: Tuesdays 1, 8, 15, 22, 29
  });

  it("first-Sunday stipend of $700 a week: 5 Sundays -> $3,500, 4 Sundays -> $2,800", async () => {
    const { amountFor } = await import("../src/routes/expenses");
    const r = { amount_mode: "per_week" as const, amount_cents: 70000, weekday: 0 };
    expect(amountFor(r, "2026-11-01")).toEqual({ cents: 350000, weeks: 5 });
    expect(amountFor(r, "2026-12-06")).toEqual({ cents: 280000, weeks: 4 });
    expect(amountFor({ ...r, amount_mode: "fixed" }, "2026-11-01")).toEqual({ cents: 70000, weeks: null });
  });

  it("generated planned row carries the month's amount; only allowed with 'nth weekday of month'", async () => {
    const today = todayInHobart();
    const body = { name: "담임목사 사례비", amount_cents: 70000, amount_mode: "per_week", account: "bank", rule: "monthly_weekday", nth: 1, weekday: 0, start_date: today };
    expect((await call("POST", "/api/recurring-expenses", { as: EDITOR, body: { ...body, rule: "weekly" } })).status).toBe(400);
    const rule = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body }));
    expect(rule.amount_text).toBe("주 $700.00 × 그달 일요일 수");
    // Generate for a known window instead of "today".
    await db.prepare("UPDATE recurring_expenses SET generate_from = '2026-10-26', start_date = '2026-10-01' WHERE id = ?").bind(rule.id).run();
    await generatePlanned(db, "2026-10-26"); // window reaches 2026-11-02 -> 2026-11-01 (5 Sundays)
    const row = await db.prepare("SELECT expense_date, total_cents, note FROM expenses").first<any>();
    expect(row).toEqual({ expense_date: "2026-11-01", total_cents: 350000, note: "고정 지출: 담임목사 사례비 (주 700.00 × 5주)" });
  });

  it("edits a paid expense; audited; void rows cannot be edited; viewer cannot", async () => {
    const e = await json(await call("POST", "/api/expenses", { as: EDITOR, body: { expense_date: "2026-11-01", vendor: "Coles", total_cents: 4550, account: "cash" } }));
    // a reason is required and kept with the change
    expect((await call("PATCH", `/api/expenses/${e.id}`, { as: EDITOR2, body: { total_cents: 4650 } })).status).toBe(400);
    expect((await call("PATCH", `/api/expenses/${e.id}`, { as: EDITOR2, body: { total_cents: 4650, reason: "  " } })).status).toBe(400);
    const r = await call("PATCH", `/api/expenses/${e.id}`, { as: EDITOR2, body: { total_cents: 4650, vendor: "Coles Hobart", note: "간식", reason: "영수증 금액 확인" } });
    expect(r.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'expenses' AND action = 'update' AND reason = '영수증 금액 확인'")).toBe(1);
    const after = await db.prepare("SELECT vendor, total_cents, note FROM expenses WHERE id = ?").bind(e.id).first();
    expect(after).toEqual({ vendor: "Coles Hobart", total_cents: 4650, note: "간식" });
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'expenses' AND action = 'update' AND user_email = ?", EDITOR2)).toBe(1);
    expect((await call("PATCH", `/api/expenses/${e.id}`, { as: PASTOR, body: { total_cents: 1, reason: "r" } })).status).toBe(403);
    expect((await call("PATCH", `/api/expenses/${e.id}`, { as: EDITOR, body: { gst_cents: 999999, reason: "r" } })).status).toBe(400);
    expect((await call("PATCH", `/api/expenses/${e.id}`, { as: EDITOR, body: { reason: "r" } })).status).toBe(400);
    await call("POST", `/api/expenses/${e.id}/void`, { as: EDITOR, body: { reason: "x" } });
    expect((await call("PATCH", `/api/expenses/${e.id}`, { as: EDITOR, body: { total_cents: 1, reason: "r" } })).status).toBe(409);
  });
});

describe("audit fixes: fixed costs and expenses", () => {
  beforeEach(resetDb);
  const today = todayInHobart();
  const wd = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const rent = { name: "렌트", amount_cents: 15000, account: "bank", rule: "weekly", weekday: wd(addDays(today, 2)), start_date: today };
  const due = async () => (await json(await call("GET", "/api/expenses/due", { as: EDITOR }))).items;

  it("stop then restart the same day brings back this week's payment (audited both ways)", async () => {
    const r = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body: rent }));
    expect(await due()).toHaveLength(1);
    await call("PATCH", `/api/recurring-expenses/${r.id}`, { as: EDITOR, body: { is_active: false } });
    expect(await due()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE table_name='expenses' AND action='void'")).toBe(1);
    await call("PATCH", `/api/recurring-expenses/${r.id}`, { as: EDITOR, body: { is_active: true } });
    const back = await due();
    expect(back).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM expenses")).toBe(1); // revived, not duplicated
  });

  it("end date pulled in then cleared brings the payment back", async () => {
    const r = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body: rent }));
    await due();
    await call("PATCH", `/api/recurring-expenses/${r.id}`, { as: EDITOR, body: { end_date: today } });
    expect(await due()).toHaveLength(0);
    await call("PATCH", `/api/recurring-expenses/${r.id}`, { as: EDITOR, body: { end_date: null } });
    expect(await due()).toHaveLength(1);
  });

  it("stopping keeps overdue unpaid rows (still owed); a person's skip is never revived", async () => {
    const r = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body: { ...rent, weekday: wd(addDays(today, -3)), start_date: addDays(today, -30) } }));
    await db.prepare("UPDATE recurring_expenses SET generate_from = ? WHERE id = ?").bind(addDays(today, -20), r.id).run();
    const items = await due();
    const overdue = items.filter((i: any) => i.overdue);
    expect(overdue.length).toBeGreaterThan(0);
    await call("POST", `/api/expenses/${overdue[0].id}/void`, { as: EDITOR, body: { reason: "면제" } });
    await call("PATCH", `/api/recurring-expenses/${r.id}`, { as: EDITOR, body: { is_active: false } });
    const left = await due();
    expect(left.every((i: any) => i.overdue)).toBe(true);
    expect(left.length).toBe(overdue.length - 1);
    await call("PATCH", `/api/recurring-expenses/${r.id}`, { as: EDITOR, body: { is_active: true } });
    expect(await count("SELECT COUNT(*) AS n FROM expenses WHERE id = ? AND status = 'void'", overdue[0].id)).toBe(1);
  });

  it("missed dates up to ~3 months back are filled in (but not before the rule existed)", async () => {
    const r = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body: { ...rent, start_date: addDays(today, -80) } }));
    await db.prepare("UPDATE recurring_expenses SET generate_from = ? WHERE id = ?").bind(addDays(today, -70), r.id).run();
    const items = await due();
    expect(items.filter((i: any) => i.overdue).length).toBeGreaterThanOrEqual(9);
    expect(items.every((i: any) => i.expense_date >= addDays(today, -70))).toBe(true);
  });

  it("no-op rule edit writes nothing; concurrent edits don't lose one silently", async () => {
    const r = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body: rent }));
    const before = await count("SELECT COUNT(*) AS n FROM audit_log");
    expect((await call("PATCH", `/api/recurring-expenses/${r.id}`, { as: EDITOR, body: { name: "렌트" } })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log")).toBe(before);
    const [a, b] = await Promise.all([
      call("PATCH", `/api/recurring-expenses/${r.id}`, { as: EDITOR, body: { name: "렌트2" } }),
      call("PATCH", `/api/recurring-expenses/${r.id}`, { as: EDITOR2, body: { amount_cents: 16000 } }),
    ]);
    const row = await db.prepare("SELECT name, amount_cents FROM recurring_expenses WHERE id = ?").bind(r.id).first<any>();
    if (a.status === 200) expect(row.name).toBe("렌트2");
    if (b.status === 200) expect(row.amount_cents).toBe(16000);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
  });

  it("pay below GST -> 400, not a server error; pay can set the actual pay date", async () => {
    await call("POST", "/api/recurring-expenses", { as: EDITOR, body: rent });
    const [item] = await due();
    await call("PATCH", `/api/expenses/${item.id}`, { as: EDITOR, body: { gst_cents: 1000, reason: "GST 확인" } });
    expect((await call("POST", `/api/expenses/${item.id}/pay`, { as: EDITOR, body: { total_cents: 500 } })).status).toBe(400);
    const ok = await call("POST", `/api/expenses/${item.id}/pay`, { as: EDITOR, body: { expense_date: today } });
    expect(await json(ok)).toMatchObject({ status: "confirmed", expense_date: today });
  });

  it("a resent one-off expense is saved once", async () => {
    const body = { expense_date: "2026-11-01", vendor: "Coles", total_cents: 4550, account: "cash", client_key: "exp-key-0001" };
    const [a, b] = await Promise.all([call("POST", "/api/expenses", { as: EDITOR, body }), call("POST", "/api/expenses", { as: EDITOR, body })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await call("POST", "/api/expenses", { as: EDITOR, body })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM expenses")).toBe(1);
  });

  it("department filter applies to the totals too", async () => {
    const d = await json(await call("POST", "/api/departments", { as: PASTOR, body: { name: "교육부" } }));
    const post = (b: object) => call("POST", "/api/expenses", { as: EDITOR, body: { expense_date: "2026-11-01", vendor: "x", account: "cash", ...b } });
    await post({ total_cents: 1000, department_id: d.id });
    await post({ total_cents: 5000 });
    const s = await json(await call("GET", `/api/expenses/summary?from=2026-11-01&to=2026-11-30&department_id=${d.id}`, { as: PASTOR }));
    expect(s.paid_cents).toBe(1000);
    expect(await json(await call("GET", `/api/expenses?from=2026-11-01&to=2026-11-30&department_id=${d.id}`, { as: PASTOR }))).toHaveLength(1);
  });
});
