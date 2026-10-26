import { beforeEach, describe, expect, it } from "vitest";
import { db, EDITOR, resetDb } from "./helpers";

async function userId() {
  const u = await db.prepare("SELECT id FROM users WHERE email = ?").bind(EDITOR).first<{ id: number }>();
  return u!.id;
}

async function idOf(table: string, name: string) {
  const r = await db.prepare(`SELECT id FROM ${table} WHERE name = ?`).bind(name).first<{ id: number }>();
  return r!.id;
}

async function rejects(sql: string, ...binds: unknown[]) {
  await expect(db.prepare(sql).bind(...binds).run()).rejects.toThrow();
}

describe("schema", () => {
  beforeEach(resetDb);

  it("seeds the six offering types and settings", async () => {
    const { results } = await db.prepare("SELECT name FROM fund_types ORDER BY sort_order").all();
    expect(results.map((r: Record<string, unknown>) => r.name)).toEqual(["주일헌금", "십일조", "선교헌금", "건축헌금", "작정헌금", "감사헌금"]);
    const s = await db.prepare("SELECT value FROM settings WHERE key = 'church_fiscal_year_start_month'").first();
    expect(s?.value).toBe("1");
  });

  it("rejects bad offerings (zero/negative amount, bad method, bad date, unknown fund)", async () => {
    const u = await userId();
    const sql =
      "INSERT INTO offerings (offering_date, fund_type_id, amount_cents, method, created_by) VALUES (?, ?, ?, ?, ?)";
    await db.prepare(sql).bind("2026-11-01", 1, 5000, "cash", u).run(); // control: valid row
    await rejects(sql, "2026-11-01", 1, 0, "cash", u);
    await rejects(sql, "2026-11-01", 1, -500, "cash", u);
    await rejects(sql, "2026-11-01", 1, 5000, "card", u);
    await rejects(sql, "11/01/2026", 1, 5000, "cash", u);
    await rejects(sql, "2026-11-01", 999, 5000, "cash", u);
  });

  it("rejects bad expenses (gst above total, bad account/status)", async () => {
    const u = await userId();
    await db.prepare("INSERT INTO departments (name) VALUES ('친교부')").run();
    const d = await idOf("departments", "친교부");
    const sql =
      "INSERT INTO expenses (expense_date, vendor, department_id, total_cents, gst_cents, account, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    await db.prepare(sql).bind("2026-11-01", "Coles", d, 2500, 227, "bank", "draft", u).run(); // control
    await rejects(sql, "2026-11-01", "Coles", d, 2500, 2600, "bank", "draft", u);
    await rejects(sql, "2026-11-01", "Coles", d, 2500, 0, "paypal", "draft", u);
    await rejects(sql, "2026-11-01", "Coles", d, 2500, 0, "bank", "paid", u);
    await rejects(sql, "2026-11-01", "Coles", d, 0, 0, "bank", "draft", u);
  });

  it("allows a negative receipt line (discount) and cascades item deletes", async () => {
    const u = await userId();
    await db.prepare("INSERT INTO departments (name) VALUES ('친교부')").run();
    const d = await idOf("departments", "친교부");
    const ins = await db
      .prepare(
        "INSERT INTO expenses (expense_date, vendor, department_id, total_cents, account, created_by) VALUES ('2026-11-01','Coles',?,1000,'cash',?)",
      )
      .bind(d, u)
      .run();
    const e = ins.meta.last_row_id;
    await db.prepare("INSERT INTO expense_items (expense_id, description, amount_cents) VALUES (?,'Milk',1200)").bind(e).run();
    await db.prepare("INSERT INTO expense_items (expense_id, description, amount_cents) VALUES (?,'Discount',-200)").bind(e).run();
    await db.prepare("DELETE FROM expenses WHERE id = ?").bind(e).run();
    const left = await db.prepare("SELECT COUNT(*) AS n FROM expense_items").first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("allows only one active opening balance per account", async () => {
    const u = await userId();
    const sql =
      "INSERT INTO opening_balances (account, as_of_date, amount_cents, status, created_by) VALUES (?, '2026-11-01', 100000, ?, ?)";
    await db.prepare(sql).bind("cash", "active", u).run();
    await rejects(sql, "cash", "active", u);
    await db.prepare(sql).bind("bank", "active", u).run(); // other account is fine
    await db.prepare(sql).bind("cash", "void", u).run(); // voided rows do not count
  });

  it("allows one budget per year/department/category scope, including department-wide", async () => {
    await db.prepare("INSERT INTO departments (name) VALUES ('교육부')").run();
    await db.prepare("INSERT INTO expense_categories (name) VALUES ('간식')").run();
    const d = await idOf("departments", "교육부");
    const cat = await idOf("expense_categories", "간식");
    const sql = "INSERT INTO budgets (fiscal_year, department_id, category_id, amount_cents) VALUES (?, ?, ?, 100000)";
    await db.prepare(sql).bind(2027, d, null).run();
    await rejects(sql, 2027, d, null); // second department-wide budget
    await db.prepare(sql).bind(2027, d, cat).run(); // category-level is a different scope
    await rejects(sql, 2027, d, cat);
    await db.prepare(sql).bind(2028, d, null).run();
  });

  it("enforces unique user emails case-insensitively", async () => {
    await rejects("INSERT INTO users (email, name, role) VALUES (?, 'x', 'viewer')", EDITOR.toUpperCase());
    await rejects("INSERT INTO users (email, name, role) VALUES ('a@b.c', 'x', 'admin')");
  });
});
