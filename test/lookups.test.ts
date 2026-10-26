import { beforeEach, describe, expect, it } from "vitest";
import { EDITOR, EDITOR2, call, db, json, resetDb } from "./helpers";

describe.each([
  ["/api/fund-types", "fund_types"],
  ["/api/departments", "departments"],
  ["/api/expense-categories", "expense_categories"],
])("lookup %s", (path, table) => {
  beforeEach(resetDb);

  it("creates, lists and records an audit entry", async () => {
    const res = await call("POST", path, { as: EDITOR, body: { name: "  새 항목  ", sort_order: 50 } });
    expect(res.status).toBe(201);
    const row = await json(res);
    expect(row).toMatchObject({ name: "새 항목", sort_order: 50, is_active: true });

    const list = await json(await call("GET", path, { as: EDITOR }));
    expect(list.some((r: { id: number }) => r.id === row.id)).toBe(true);

    const log = await json(await call("GET", "/api/audit-log?limit=1", { as: EDITOR }));
    expect(log[0]).toMatchObject({
      action: "create",
      table_name: table,
      row_id: row.id,
      user_email: EDITOR,
      before: null,
      after: { name: "새 항목", sort_order: 50 },
    });
  });

  it("rejects duplicate names (case-insensitive) with 409", async () => {
    await call("POST", path, { as: EDITOR, body: { name: "Alpha" } });
    expect((await call("POST", path, { as: EDITOR, body: { name: "alpha" } })).status).toBe(409);
  });

  it("validates input", async () => {
    for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(51) }, { name: "a", extra: 1 }, { name: "a", sort_order: -1 }]) {
      expect((await call("POST", path, { as: EDITOR, body })).status).toBe(400);
    }
    const bad = await call("POST", path, { as: EDITOR, headers: { "Content-Type": "application/json" } });
    expect(bad.status).toBe(400); // empty body is not valid JSON
  });

  it("updates, deactivates and hides inactive rows by default; audit keeps before/after", async () => {
    const { id } = await json(await call("POST", path, { as: EDITOR, body: { name: "임시" } }));
    const upd = await call("PATCH", `${path}/${id}`, { as: EDITOR2, body: { name: "바뀜", is_active: false } });
    expect(upd.status).toBe(200);
    expect(await json(upd)).toMatchObject({ id, name: "바뀜", is_active: false });

    const visible = await json(await call("GET", path, { as: EDITOR }));
    expect(visible.find((r: { id: number }) => r.id === id)).toBeUndefined();
    const all = await json(await call("GET", `${path}?include_inactive=1`, { as: EDITOR }));
    expect(all.find((r: { id: number }) => r.id === id)).toMatchObject({ name: "바뀜", is_active: false });

    const log = await json(await call("GET", "/api/audit-log?limit=1", { as: EDITOR }));
    expect(log[0]).toMatchObject({ action: "update", user_email: EDITOR2, row_id: id });
    expect(log[0].before).toMatchObject({ name: "임시", is_active: 1 });
    expect(log[0].after).toMatchObject({ name: "바뀜", is_active: 0 });
  });

  it("handles missing rows, empty updates and renaming onto an existing name", async () => {
    expect((await call("PATCH", `${path}/999999`, { as: EDITOR, body: { name: "x" } })).status).toBe(404);
    const a = await json(await call("POST", path, { as: EDITOR, body: { name: "A-item" } }));
    await call("POST", path, { as: EDITOR, body: { name: "B-item" } });
    expect((await call("PATCH", `${path}/${a.id}`, { as: EDITOR, body: {} })).status).toBe(400);
    expect((await call("PATCH", `${path}/${a.id}`, { as: EDITOR, body: { name: "B-item" } })).status).toBe(409);
    expect((await call("PATCH", `${path}/abc`, { as: EDITOR, body: { name: "x" } })).status).toBe(404);
  });

  it("has no delete endpoint", async () => {
    const { id } = await json(await call("POST", path, { as: EDITOR, body: { name: "지우기" } }));
    expect((await call("DELETE", `${path}/${id}`, { as: EDITOR })).status).toBe(404);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).bind(id).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("writes nothing when a create fails (change and audit are atomic)", async () => {
    await call("POST", path, { as: EDITOR, body: { name: "Dup" } });
    const before = await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    await call("POST", path, { as: EDITOR, body: { name: "Dup" } });
    const after = await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });
});
