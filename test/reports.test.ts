import { beforeEach, describe, expect, it } from "vitest";
import { EDITOR, PASTOR, call, db, json, resetDb } from "./helpers";

async function seed() {
  await call("POST", "/api/opening-balances", { as: EDITOR, body: { account: "cash", as_of_date: "2026-10-01", amount_cents: 100000 } });
  await call("POST", "/api/opening-balances", { as: EDITOR, body: { account: "bank", as_of_date: "2026-10-01", amount_cents: 2000000 } });
  const d = await json(await call("POST", "/api/departments", { as: EDITOR, body: { name: "교육부" } }));
  const off = (date: string, entries: unknown[]) => call("POST", "/api/offerings", { as: EDITOR, body: { offering_date: date, entries } });
  await off("2026-10-04", [{ fund_type_id: 1, amount_cents: 30000, method: "cash" }, { fund_type_id: 2, amount_cents: 50000, method: "online" }]);
  const [v] = await json(await off("2026-11-01", [{ fund_type_id: 6, amount_cents: 99900, method: "cash", note: "=HYPERLINK(\"x\")" }]));
  await call("POST", `/api/offerings/${v.id}/void`, { as: EDITOR, body: { reason: "오입력" } });
  await off("2026-11-08", [{ fund_type_id: 1, amount_cents: 20000, method: "cash" }]);
  const exp = (b: object) => call("POST", "/api/expenses", { as: EDITOR, body: { vendor: "Coles, Hobart", account: "cash", ...b } });
  await exp({ expense_date: "2026-10-10", total_cents: 4550, gst_cents: 414, department_id: d.id });
  await exp({ expense_date: "2026-11-02", total_cents: 150000, account: "bank" });
  return d;
}

describe("period report", () => {
  beforeEach(resetDb);

  it("balances: start, income, expenses, end — voided and planned rows never count", async () => {
    await seed();
    const s = await json(await call("GET", "/api/reports/summary?from=2026-11-01&to=2026-11-30", { as: PASTOR }));
    const cash = s.balances.find((b: any) => b.account === "cash");
    const bank = s.balances.find((b: any) => b.account === "bank");
    // cash: 1000 + 300 (10-04) - 45.50 (10-10) = 1254.50 at 11-01; +200 (11-08) -> 1454.50
    expect(cash).toMatchObject({ start_cents: 125450, end_cents: 145450 });
    // bank: 20000 + 500 (10-04) = 20500 at 11-01; -1500 (11-02) -> 19000
    expect(bank).toMatchObject({ start_cents: 2050000, end_cents: 1900000 });
    expect(s.income).toMatchObject({ cash_cents: 20000, online_cents: 0, total_cents: 20000 });
    expect(s.expenses).toMatchObject({ cash_cents: 0, bank_cents: 150000, total_cents: 150000 });
    expect(s.notes).toEqual([]);
  });

  it("a period starting before the opening-balance date says so", async () => {
    await seed();
    const s = await json(await call("GET", "/api/reports/summary?from=2026-07-01&to=2026-09-30", { as: PASTOR }));
    expect(s.notes.length).toBeGreaterThan(0);
    expect(s.balances.find((b: any) => b.account === "cash").end_cents).toBeNull(); // whole period before the opening date
  });

  it("validates the period", async () => {
    for (const q of ["", "from=2026-11-01", "from=2026-12-01&to=2026-11-01", "from=x&to=y"]) {
      expect((await call("GET", `/api/reports/summary?${q}`, { as: PASTOR })).status).toBe(400);
    }
  });
});

describe("CSV exports", () => {
  beforeEach(resetDb);

  const text = async (path: string) => {
    const r = await call("GET", path, { as: PASTOR });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/csv");
    const kind = path.split("/").pop()!.split(".")[0];
    const q = new URL(path, "http://x").searchParams;
    expect(r.headers.get("Content-Disposition")).toBe(`attachment; filename="${kind}_${q.get("from")}_${q.get("to")}.csv"`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM so Excel reads Korean correctly
    return new TextDecoder().decode(bytes); // (the decoder drops the BOM)
  };

  it("offerings: every row incl. voided, with a column that only counts valid ones; Excel-safe", async () => {
    await seed();
    const t = await text("/api/reports/offerings.csv?from=2026-10-01&to=2026-12-31");
    const lines = t.trim().split("\r\n");
    expect(lines[0]).toBe("날짜,헌금 종류,방식,성도,교인ID,금액(AUD),합계에 포함,상태,취소 사유,메모,입력 시각(UTC)");
    expect(lines).toHaveLength(5); // header + 4 offerings
    const voided = lines.find((l) => l.includes("오입력"))!;
    expect(voided).toContain(",999,0,취소,오입력,");
    expect(voided).toContain(`"'=HYPERLINK(""x"")"`); // formula neutralised, quotes escaped
  });

  it("expenses: commas quoted, GST and status columns", async () => {
    await seed();
    const t = await text("/api/reports/expenses.csv?from=2026-10-01&to=2026-12-31");
    const lines = t.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Coles, Hobart"');
    expect(lines[1]).toContain(",현금,45.5,4.14,45.5,지급,");
  });

  it("summary CSV has the balance lines", async () => {
    await seed();
    const t = await text("/api/reports/summary.csv?from=2026-11-01&to=2026-11-30");
    expect(t).toContain("잔액,기간 시작,1254.5,20500,21754.5");
    expect(t).toContain("잔액,기간 끝,1454.5,19000,20454.5");
  });

  it("requires login", async () => {
    expect((await call("GET", "/api/reports/offerings.csv?from=2026-10-01&to=2026-12-31")).status).toBe(401);
  });
});
