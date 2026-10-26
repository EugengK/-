import { beforeEach, describe, expect, it } from "vitest";
import { EDITOR, EDITOR2, PASTOR, call, db, json, resetDb } from "./helpers";

const count = async (sql: string, ...b: unknown[]) =>
  (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;

async function member(name: string, extra: Record<string, unknown> = {}) {
  return json(await call("POST", "/api/members", { as: EDITOR, body: { name, ...extra } }));
}

describe("members", () => {
  beforeEach(resetDb);

  it("creates, searches, updates and deactivates; duplicates allowed; audited", async () => {
    const a = await member("김철수", { phone: " 0400 000 000 ", note: "" });
    expect(a).toMatchObject({ name: "김철수", phone: "0400 000 000", note: null, is_active: true });
    await member("김철수", { note: "청년부" }); // same name, different person
    await member("이영희");

    expect(await json(await call("GET", "/api/members?q=철수", { as: PASTOR }))).toHaveLength(2);
    expect(await json(await call("GET", "/api/members?q=%25", { as: PASTOR }))).toHaveLength(0); // literal %

    const upd = await call("PATCH", `/api/members/${a.id}`, { as: EDITOR2, body: { phone: null, is_active: false } });
    expect(upd.status).toBe(200);
    expect(await json(upd)).toMatchObject({ phone: null, is_active: false });
    expect(await json(await call("GET", "/api/members", { as: PASTOR }))).toHaveLength(2);
    expect(await json(await call("GET", "/api/members?include_inactive=1", { as: PASTOR }))).toHaveLength(3);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'members'")).toBe(4);
  });

  it("validates and blocks viewers", async () => {
    for (const body of [{}, { name: "" }, { name: "a", phone: "1".repeat(31) }, { name: "a", age: 3 }]) {
      expect((await call("POST", "/api/members", { as: EDITOR, body })).status).toBe(400);
    }
    expect((await call("POST", "/api/members", { as: PASTOR, body: { name: "x" } })).status).toBe(403);
    expect((await call("PATCH", "/api/members/99999", { as: EDITOR, body: { name: "x" } })).status).toBe(404);
  });

  it("a stale concurrent edit gets 409 and no audit row", async () => {
    const m = await member("박");
    const [x, y] = await Promise.all([
      call("PATCH", `/api/members/${m.id}`, { as: EDITOR, body: { name: "박1" } }),
      call("PATCH", `/api/members/${m.id}`, { as: EDITOR2, body: { note: "메모" } }),
    ]);
    const ok = [x, y].filter((r) => r.status === 200).length;
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action='update' AND row_id = ?", m.id)).toBe(ok);
    const row = await db.prepare("SELECT name, note FROM members WHERE id = ?").bind(m.id).first<any>();
    if (x.status === 200) expect(row.name).toBe("박1");
    if (y.status === 200) expect(row.note).toBe("메모");
  });
});

describe("offerings", () => {
  beforeEach(resetDb);

  it("records a whole service at once, with and without a named giver", async () => {
    const kim = await member("김철수");
    const res = await call("POST", "/api/offerings", {
      as: EDITOR,
      body: {
        offering_date: "2026-11-01",
        entries: [
          { fund_type_id: 1, amount_cents: 45000, method: "cash" }, // 주일헌금, anonymous
          { fund_type_id: 2, amount_cents: 30000, method: "online", member_id: kim.id }, // 십일조
          { fund_type_id: 6, amount_cents: 5000, method: "cash", member_id: kim.id, note: "생일 감사" },
        ],
      },
    });
    expect(res.status).toBe(201);
    const rows = await json(res);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ fund_type_name: "십일조", member_name: "김철수", method: "online", amount_cents: 30000 });
    // Each row has its own audit entry pointing at it.
    const log = await db.prepare("SELECT row_id FROM audit_log WHERE table_name='offerings' ORDER BY id").all<any>();
    expect(log.results.map((r) => r.row_id)).toEqual(rows.map((r: any) => r.id));
  });

  it("is all-or-nothing: one bad line writes nothing", async () => {
    await call("PATCH", "/api/fund-types/5", { as: EDITOR, body: { is_active: false } });
    const before = await count("SELECT COUNT(*) AS n FROM audit_log");
    for (const entries of [
      [{ fund_type_id: 1, amount_cents: 100, method: "cash" }, { fund_type_id: 5, amount_cents: 100, method: "cash" }],
      [{ fund_type_id: 1, amount_cents: 100, method: "cash" }, { fund_type_id: 999, amount_cents: 100, method: "cash" }],
      [{ fund_type_id: 1, amount_cents: 100, method: "cash", member_id: 99999 }],
    ]) {
      const r = await call("POST", "/api/offerings", { as: EDITOR, body: { offering_date: "2026-11-01", entries } });
      expect(r.status).toBe(400);
    }
    expect(await count("SELECT COUNT(*) AS n FROM offerings")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log")).toBe(before);
  });

  it("validates amounts, method, date and size", async () => {
    const line = { fund_type_id: 1, amount_cents: 100, method: "cash" };
    const bad = [
      { offering_date: "2026-11-01", entries: [] },
      { offering_date: "2026-11-01", entries: [{ ...line, amount_cents: 0 }] },
      { offering_date: "2026-11-01", entries: [{ ...line, amount_cents: -5 }] },
      { offering_date: "2026-11-01", entries: [{ ...line, amount_cents: 10.5 }] },
      { offering_date: "2026-11-01", entries: [{ ...line, method: "card" }] },
      { offering_date: "2026-02-30", entries: [line] },
      { offering_date: "2026-11-01", entries: Array(51).fill(line) },
      { offering_date: "2026-11-01", entries: [{ ...line, created_by: 1 }] },
    ];
    for (const body of bad) expect((await call("POST", "/api/offerings", { as: EDITOR, body })).status).toBe(400);
    const ok = await call("POST", "/api/offerings", { as: EDITOR, body: { offering_date: "2026-11-01", entries: Array(50).fill(line) } });
    expect(ok.status).toBe(201);
  });

  it("filters, summarises by type and method, and excludes voided rows", async () => {
    const kim = await member("김철수");
    const post = (d: string, entries: unknown[]) =>
      call("POST", "/api/offerings", { as: EDITOR, body: { offering_date: d, entries } });
    await post("2026-10-25", [{ fund_type_id: 1, amount_cents: 10000, method: "cash" }]);
    const nov = await json(
      await post("2026-11-01", [
        { fund_type_id: 1, amount_cents: 20000, method: "cash" },
        { fund_type_id: 1, amount_cents: 7000, method: "online" },
        { fund_type_id: 2, amount_cents: 30000, method: "online", member_id: kim.id },
        { fund_type_id: 2, amount_cents: 99900, method: "cash", member_id: kim.id },
      ]),
    );
    // The last line was a typo: void it.
    const v = await call("POST", `/api/offerings/${nov[3].id}/void`, { as: EDITOR2, body: { reason: "금액 오입력" } });
    expect(v.status).toBe(200);

    const list = await json(await call("GET", "/api/offerings?from=2026-11-01&to=2026-11-30", { as: PASTOR }));
    expect(list).toHaveLength(3);
    expect(await json(await call("GET", "/api/offerings?from=2026-11-01&include_void=1", { as: PASTOR }))).toHaveLength(4);

    const s = await json(await call("GET", "/api/offerings/summary?from=2026-11-01&to=2026-11-30", { as: PASTOR }));
    expect(s).toMatchObject({ total_cents: 57000, cash_cents: 20000, online_cents: 37000 });
    expect(s.rows.find((r: any) => r.fund_type_id === 1 && r.method === "online").total_cents).toBe(7000);

    const mine = await json(await call("GET", `/api/offerings/summary?member_id=${kim.id}`, { as: PASTOR }));
    expect(mine.total_cents).toBe(30000);

    expect(await json(await call("GET", "/api/offerings?method=cash&fund_type_id=1", { as: PASTOR }))).toHaveLength(2);
  });

  it("rejects bad filters with 400 rather than 500", async () => {
    for (const q of ["from=2026-13-01", "to=yesterday", "member_id=abc", "fund_type_id=1.5", "method=card"]) {
      expect((await call("GET", `/api/offerings?${q}`, { as: PASTOR })).status).toBe(400);
      expect((await call("GET", `/api/offerings/summary?${q}`, { as: PASTOR })).status).toBe(400);
    }
  });

  it("void needs a reason, works once, and races log exactly one void", async () => {
    const [o] = await json(
      await call("POST", "/api/offerings", {
        as: EDITOR,
        body: { offering_date: "2026-11-01", entries: [{ fund_type_id: 1, amount_cents: 100, method: "cash" }] },
      }),
    );
    expect((await call("POST", `/api/offerings/${o.id}/void`, { as: EDITOR, body: {} })).status).toBe(400);
    expect((await call("POST", `/api/offerings/${o.id}/void`, { as: PASTOR, body: { reason: "x" } })).status).toBe(403);
    const [a, b] = await Promise.all([
      call("POST", `/api/offerings/${o.id}/void`, { as: EDITOR, body: { reason: "A" } }),
      call("POST", `/api/offerings/${o.id}/void`, { as: EDITOR2, body: { reason: "B" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action='void' AND row_id = ?", o.id)).toBe(1);
    expect((await call("POST", "/api/offerings/99999/void", { as: EDITOR, body: { reason: "x" } })).status).toBe(404);
  });

  it("has no edit or delete endpoints", async () => {
    expect((await call("PATCH", "/api/offerings/1", { as: EDITOR, body: { amount_cents: 1 } })).status).toBe(404);
    expect((await call("DELETE", "/api/offerings/1", { as: EDITOR })).status).toBe(404);
  });
});
