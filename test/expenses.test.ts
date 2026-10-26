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

  it("fills in missed dates from the last month as overdue", async () => {
    await call("POST", "/api/recurring-expenses", { as: EDITOR, body: stipend });
    const due = await json(await call("GET", "/api/expenses/due", { as: EDITOR }));
    expect(due.items.length).toBeGreaterThanOrEqual(1);
    expect(due.items.every((i: any) => i.expense_date >= addDays(today, -31))).toBe(true);
    expect(due.items.some((i: any) => i.overdue)).toBe(due.items.some((i: any) => i.expense_date < today));
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

  it("stopping a rule stops new dates; changing the amount applies to new dates only", async () => {
    const rule = await json(await call("POST", "/api/recurring-expenses", { as: EDITOR, body: { ...weeklyRent, start_date: addDays(today, -30) } }));
    await call("GET", "/api/expenses/due", { as: EDITOR });
    const before = await count("SELECT COUNT(*) AS n FROM expenses");
    await db.prepare("DELETE FROM expenses WHERE expense_date > ?").bind(today).run(); // pretend the future ones weren't made yet
    await call("PATCH", `/api/recurring-expenses/${rule.id}`, { as: EDITOR, body: { is_active: false } });
    await call("GET", "/api/expenses/due", { as: EDITOR });
    expect(await count("SELECT COUNT(*) AS n FROM expenses WHERE expense_date > ?", today)).toBe(0);
    expect(before).toBeGreaterThan(0);
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
