import { beforeEach, describe, expect, it } from "vitest";
import { EDITOR, EDITOR2, PASTOR, call, json, resetDb } from "./helpers";

const valid = { account: "bank", as_of_date: "2026-11-01", amount_cents: 1234567, note: "합병 시점 잔액" };

describe("opening balances", () => {
  beforeEach(resetDb);

  it("creates a balance, lists it and audits it", async () => {
    const res = await call("POST", "/api/opening-balances", { as: PASTOR, body: valid });
    expect(res.status).toBe(201);
    const row = await json(res);
    expect(row).toMatchObject({ account: "bank", amount_cents: 1234567, status: "active", note: "합병 시점 잔액" });

    const list = await json(await call("GET", "/api/opening-balances", { as: PASTOR }));
    expect(list).toHaveLength(1);

    const log = await json(await call("GET", "/api/audit-log?limit=1", { as: PASTOR }));
    expect(log[0]).toMatchObject({ action: "create", table_name: "opening_balances", row_id: row.id });
  });

  it("allows cash and bank once each, and refuses a second active balance", async () => {
    expect((await call("POST", "/api/opening-balances", { as: PASTOR, body: valid })).status).toBe(201);
    expect(
      (await call("POST", "/api/opening-balances", { as: PASTOR, body: { ...valid, account: "cash", amount_cents: 50000 } })).status,
    ).toBe(201);
    expect((await call("POST", "/api/opening-balances", { as: PASTOR, body: valid })).status).toBe(409);
  });

  it("validates account, date, amount and unknown fields", async () => {
    const bad: unknown[] = [
      { ...valid, account: "paypal" },
      { ...valid, as_of_date: "2026-02-30" },
      { ...valid, as_of_date: "01/11/2026" },
      { ...valid, amount_cents: 12.5 },
      { ...valid, amount_cents: "100" },
      { ...valid, amount_cents: 1e15 },
      { ...valid, status: "void" },
      { account: "bank" },
    ];
    for (const body of bad) {
      expect((await call("POST", "/api/opening-balances", { as: PASTOR, body })).status).toBe(400);
    }
  });

  it("accepts a zero or negative balance (e.g. overdrawn account)", async () => {
    expect((await call("POST", "/api/opening-balances", { as: PASTOR, body: { ...valid, amount_cents: 0 } })).status).toBe(201);
    expect(
      (await call("POST", "/api/opening-balances", { as: PASTOR, body: { ...valid, account: "cash", amount_cents: -1000 } })).status,
    ).toBe(201);
  });

  it("voids with a reason, then allows re-entering; voided rows are hidden by default", async () => {
    const first = await json(await call("POST", "/api/opening-balances", { as: PASTOR, body: valid }));
    expect((await call("POST", `/api/opening-balances/${first.id}/void`, { as: PASTOR, body: {} })).status).toBe(400);
    const voided = await call("POST", `/api/opening-balances/${first.id}/void`, { as: PASTOR, body: { reason: "금액 오입력" } });
    expect(voided.status).toBe(200);
    expect(await json(voided)).toMatchObject({ status: "void", void_reason: "금액 오입력" });

    expect(await json(await call("GET", "/api/opening-balances", { as: EDITOR }))).toHaveLength(0);
    expect(await json(await call("GET", "/api/opening-balances?include_void=1", { as: EDITOR }))).toHaveLength(1);

    const again = await call("POST", "/api/opening-balances", { as: PASTOR, body: { ...valid, amount_cents: 1000000 } });
    expect(again.status).toBe(201);

    const log = await json(await call("GET", "/api/audit-log?limit=3", { as: PASTOR }));
    expect(log.map((l: { action: string }) => l.action)).toEqual(["create", "void", "create"]);
    expect(log[1]).toMatchObject({ user_email: PASTOR, user_name: "담임목사", reason: "금액 오입력" });
    expect(log[1].before).toMatchObject({ status: "active", amount_cents: 1234567 });
  });

  it("cannot void twice or void a missing row", async () => {
    const row = await json(await call("POST", "/api/opening-balances", { as: PASTOR, body: valid }));
    await call("POST", `/api/opening-balances/${row.id}/void`, { as: PASTOR, body: { reason: "x" } });
    expect((await call("POST", `/api/opening-balances/${row.id}/void`, { as: PASTOR, body: { reason: "x" } })).status).toBe(409);
    expect((await call("POST", "/api/opening-balances/99999/void", { as: PASTOR, body: { reason: "x" } })).status).toBe(404);
  });

  it("does not expose update or delete", async () => {
    const row = await json(await call("POST", "/api/opening-balances", { as: PASTOR, body: valid }));
    expect((await call("PATCH", `/api/opening-balances/${row.id}`, { as: PASTOR, body: { amount_cents: 1 } })).status).toBe(404);
    expect((await call("DELETE", `/api/opening-balances/${row.id}`, { as: PASTOR })).status).toBe(404);
    expect((await call("POST", "/api/opening-balances", { as: EDITOR, body: valid })).status).toBe(403); // the pastor sets them
  });
});

describe("audit log, users and settings", () => {
  beforeEach(resetDb);

  it("pages through the audit log newest-first", async () => {
    for (const n of ["a1", "a2", "a3"]) await call("POST", "/api/departments", { as: PASTOR, body: { name: n } });
    const page1 = await json(await call("GET", "/api/audit-log?limit=2", { as: PASTOR }));
    expect(page1.map((l: { after: { name: string } }) => l.after.name)).toEqual(["a3", "a2"]);
    const page2 = await json(await call("GET", `/api/audit-log?limit=2&before_id=${page1[1].id}`, { as: PASTOR }));
    expect(page2.map((l: { after: { name: string } }) => l.after.name)).toEqual(["a1"]);
  });

  it("clamps silly limits instead of failing", async () => {
    expect((await call("GET", "/api/audit-log?limit=99999", { as: PASTOR })).status).toBe(200);
    expect((await call("GET", "/api/audit-log?limit=abc&before_id=xyz", { as: PASTOR })).status).toBe(200);
  });

  it("lists users and settings for any registered user", async () => {
    const users = await json(await call("GET", "/api/users", { as: PASTOR }));
    expect(users.map((u: { role: string }) => u.role).sort()).toEqual(["editor", "editor", "viewer"]);
    const settings = await json(await call("GET", "/api/settings", { as: PASTOR }));
    expect(settings).toMatchObject({ church_name: "호바트한인교회", currency: "AUD", church_fiscal_year_start_month: "1", au_fiscal_year_start_month: "7" });
  });

  it("returns JSON 404 for unknown API paths and never leaks internals", async () => {
    const res = await call("GET", "/api/nope", { as: EDITOR });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "찾을 수 없습니다." });
  });
});
