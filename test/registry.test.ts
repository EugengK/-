import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayInHobart } from "../src/dates";
import { EDITOR, PASTOR, app, call, db, json, resetDb } from "./helpers";

const count = async (sql: string, ...b: unknown[]) =>
  (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const TOKEN = "t".repeat(40);
const syncEnv = (token?: string) =>
  ({ DB: env.DB, ENVIRONMENT: "production", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", SYNC_TOKEN: token }) as unknown as typeof env;
const sync = (body: unknown, opts: { token?: string; auth?: string; type?: string } = {}) =>
  app.request(
    "https://finance.example.org/api/registry/sync",
    {
      method: "POST",
      headers: { Authorization: opts.auth ?? `Bearer ${TOKEN}`, "Content-Type": opts.type ?? "application/json" },
      body: JSON.stringify(body),
    },
    syncEnv(opts.token === undefined ? TOKEN : opts.token),
  );
const person = (code: string, name: string, extra: Record<string, unknown> = {}) => ({
  member_code: code, family_code: "F-1", name, relation: "본인", registered_on: "2026-08-09", ...extra,
});

async function newMember(name: string) {
  return json(await call("POST", "/api/members", { as: PASTOR, body: { name } }));
}

describe("titles (직분)", () => {
  beforeEach(resetDb);

  it("seeds the six titles; 집사 is a yearly appointment", async () => {
    const t = await json(await call("GET", "/api/registry/titles", { as: EDITOR }));
    expect(t.map((x: any) => x.name)).toEqual(["성도", "청년", "집사", "장립집사", "권사", "장로"]);
    expect(t.find((x: any) => x.name === "집사").term_limited).toBe(true);
    expect(t.find((x: any) => x.name === "장로").term_limited).toBe(false);
  });

  it("only the pastor manages titles", async () => {
    expect((await call("POST", "/api/registry/titles", { as: EDITOR, body: { name: "전도사" } })).status).toBe(403);
    const r = await call("POST", "/api/registry/titles", { as: PASTOR, body: { name: "전도사" } });
    expect(r.status).toBe(201);
    expect((await call("POST", "/api/registry/titles", { as: PASTOR, body: { name: "전도사" } })).status).toBe(409);
    const id = (await json(r)).id;
    expect((await call("PATCH", `/api/registry/titles/${id}`, { as: PASTOR, body: { is_active: false } })).status).toBe(200);
  });
});

describe("title history", () => {
  beforeEach(resetDb);

  it("yearly titles end on 31 Dec by default; current title follows the dates", async () => {
    const m = await newMember("홍길동");
    const year = todayInHobart().slice(0, 4);
    const r = await call("POST", `/api/registry/members/${m.id}/titles`, { as: PASTOR, body: { title_id: 3, start_date: `${year}-01-01` } });
    expect(r.status).toBe(201);
    expect((await json(r)).end_date).toBe(`${year}-12-31`);
    // A future appointment is not current yet.
    await call("POST", `/api/registry/members/${m.id}/titles`, { as: PASTOR, body: { title_id: 4, start_date: `${Number(year) + 1}-01-01` } });

    const list = await json(await call("GET", "/api/members", { as: EDITOR }));
    expect(list.find((x: any) => x.id === m.id).current_title).toBe("집사");

    const exp = await json(await call("GET", `/api/registry/expiring?year=${year}`, { as: PASTOR }));
    expect(exp.map((e: any) => [e.member_name, e.title_name])).toEqual([["홍길동", "집사"]]);
  });

  it("validates dates and titles; voiding removes it from 'current'", async () => {
    const m = await newMember("임꺽정");
    const bad = [
      { title_id: 999, start_date: "2026-01-01" },
      { title_id: 1, start_date: "2026-13-01" },
      { title_id: 1, start_date: "2026-05-01", end_date: "2026-04-01" },
      { title_id: 1, start_date: "2026-05-01", extra: 1 },
    ];
    for (const body of bad) expect((await call("POST", `/api/registry/members/${m.id}/titles`, { as: PASTOR, body })).status).toBe(400);
    expect((await call("POST", "/api/registry/members/99999/titles", { as: PASTOR, body: { title_id: 1, start_date: "2026-01-01" } })).status).toBe(404);
    expect((await call("POST", `/api/registry/members/${m.id}/titles`, { as: EDITOR, body: { title_id: 1, start_date: "2026-01-01" } })).status).toBe(403);

    const t = await json(await call("POST", `/api/registry/members/${m.id}/titles`, { as: PASTOR, body: { title_id: 6, start_date: "2020-01-01" } }));
    expect(t.end_date).toBeNull(); // 장로 is open-ended
    expect((await call("POST", `/api/registry/member-titles/${t.id}/void`, { as: PASTOR, body: { reason: "오입력" } })).status).toBe(200);
    expect((await call("POST", `/api/registry/member-titles/${t.id}/void`, { as: PASTOR, body: { reason: "오입력" } })).status).toBe(409);
    const list = await json(await call("GET", "/api/members", { as: EDITOR }));
    expect(list.find((x: any) => x.id === m.id).current_title).toBeNull();
  });
});

describe("attendance status history", () => {
  beforeEach(resetDb);

  it("left -> hidden from giver list; returned -> back; voiding recomputes", async () => {
    await sync({ people: [person("P-9", "떠난분", { registered_on: "2020-01-01" })] });
    const m = (await json(await call("GET", "/api/members", { as: EDITOR }))).find((x: any) => x.member_code === "P-9");
    const left = await json(await call("POST", `/api/registry/members/${m.id}/status`, { as: PASTOR, body: { status_code: "left", event_date: "2026-03-01", note: "타주 이사" } }));
    expect((await json(await call("GET", "/api/members", { as: EDITOR }))).some((x: any) => x.id === m.id)).toBe(false);
    const all = await json(await call("GET", "/api/members?include_inactive=1", { as: EDITOR }));
    expect(all.find((x: any) => x.id === m.id).current_status).toBe("left");

    await call("POST", `/api/registry/members/${m.id}/status`, { as: PASTOR, body: { status_code: "returned", event_date: "2026-09-01" } });
    expect((await json(await call("GET", "/api/members", { as: EDITOR }))).find((x: any) => x.id === m.id).current_status).toBe("returned");

    // An earlier-dated event added later does not override the latest one.
    await call("POST", `/api/registry/members/${m.id}/status`, { as: PASTOR, body: { status_code: "inactive", event_date: "2026-05-01" } });
    expect((await json(await call("GET", "/api/members", { as: EDITOR }))).find((x: any) => x.id === m.id).current_status).toBe("returned");

    // Void "returned" -> the latest is now 'inactive' (still listed); void that too -> 'left' (hidden).
    const detail = await json(await call("GET", `/api/registry/members/${m.id}`, { as: PASTOR }));
    const returned = detail.statuses.find((s: any) => s.status_code === "returned");
    const inactive = detail.statuses.find((s: any) => s.status_code === "inactive");
    await call("POST", `/api/registry/status-events/${returned.id}/void`, { as: PASTOR, body: { reason: "x" } });
    await call("POST", `/api/registry/status-events/${inactive.id}/void`, { as: PASTOR, body: { reason: "x" } });
    expect((await json(await call("GET", "/api/members", { as: EDITOR }))).some((x: any) => x.id === m.id)).toBe(false);
    expect(left.status_code).toBe("left");
  });

  it("rejects unknown codes and non-pastor writes", async () => {
    const m = await newMember("x");
    expect((await call("POST", `/api/registry/members/${m.id}/status`, { as: PASTOR, body: { status_code: "gone", event_date: "2026-01-01" } })).status).toBe(400);
    expect((await call("POST", `/api/registry/members/${m.id}/status`, { as: EDITOR, body: { status_code: "left", event_date: "2026-01-01" } })).status).toBe(403);
  });
});

describe("member detail", () => {
  beforeEach(resetDb);

  it("shows titles, statuses, family and giving per year", async () => {
    await sync({ people: [person("P-1", "아빠"), person("P-2", "아이", { relation: "자녀" })] });
    const [dad, kid] = (await json(await call("GET", "/api/members", { as: EDITOR }))).sort((a: any, b: any) => a.member_code.localeCompare(b.member_code));
    const post = (d: string, cents: number, fund = 1) =>
      call("POST", "/api/offerings", { as: EDITOR, body: { offering_date: d, entries: [{ fund_type_id: fund, amount_cents: cents, method: "cash", member_id: kid.id }] } });
    await post("2025-12-28", 500);
    await post("2026-01-04", 1000);
    await post("2026-02-01", 2000, 2);
    const d = await json(await call("GET", `/api/registry/members/${kid.id}`, { as: PASTOR }));
    expect(d).toMatchObject({ name: "아이", relation: "자녀", member_code: "P-2" });
    expect(d.family.map((f: any) => f.id)).toEqual([dad.id]);
    expect(d.statuses[0].status_code).toBe("registered");
    expect(d.giving_by_year.map((g: any) => [g.year, g.fund_type_name, g.total_cents])).toEqual([
      ["2026", "주일헌금", 1000],
      ["2026", "십일조", 2000],
      ["2025", "주일헌금", 500],
    ]);
    expect((await call("GET", "/api/registry/members/99999", { as: PASTOR })).status).toBe(404);
  });
});

describe("sheet sync", () => {
  beforeEach(resetDb);

  it("fails closed without a configured token and rejects wrong tokens", async () => {
    expect((await sync({ people: [person("P-1", "a")] }, { token: "" })).status).toBe(503);
    expect((await sync({ people: [person("P-1", "a")] }, { token: "short" })).status).toBe(503);
    expect((await sync({ people: [person("P-1", "a")] }, { auth: "Bearer wrong" })).status).toBe(401);
    expect((await sync({ people: [person("P-1", "a")] }, { auth: "" })).status).toBe(401);
    expect((await sync({ people: [person("P-1", "a")] }, { type: "text/plain" })).status).toBe(415);
    expect(await count("SELECT COUNT(*) AS n FROM members")).toBe(0);
  });

  it("is not reachable with a user login instead of the token", async () => {
    const r = await app.request(
      "https://finance.example.org/api/registry/sync",
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": `tok:${PASTOR}`, "Content-Type": "application/json" }, body: JSON.stringify({ people: [person("P-1", "a")] }) },
      syncEnv(TOKEN),
    );
    expect(r.status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM members")).toBe(0);
  });

  it("adds new people as registered, then only updates what changed", async () => {
    const r1 = await sync({ people: [person("P-1", "윤영자"), person("P-2", "정경남", { relation: "배우자" })] });
    expect(await json(r1)).toEqual({ created: 2, updated: 0, unchanged: 0 });
    const rows = await db.prepare("SELECT name, member_code, family_code, relation, registered_on, is_active FROM members ORDER BY member_code").all();
    expect(rows.results[0]).toMatchObject({ name: "윤영자", member_code: "P-1", family_code: "F-1", relation: "본인", registered_on: "2026-08-09", is_active: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM member_status_events WHERE status_code = 'registered' AND event_date = '2026-08-09'")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE user_email = 'sheet-sync@system.local' AND action = 'create'")).toBe(2);

    const r2 = await sync({ people: [person("P-1", "윤영자"), person("P-2", "정경남 ", { relation: "배우자" })] });
    expect(await json(r2)).toEqual({ created: 0, updated: 0, unchanged: 2 });
    const r3 = await sync({ people: [person("P-1", "윤영자B")] });
    expect(await json(r3)).toEqual({ created: 0, updated: 1, unchanged: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM members WHERE name = '윤영자B'")).toBe(1);
  });

  it("never marks people as left and keeps titles/status set by the pastor", async () => {
    await sync({ people: [person("P-1", "a"), person("P-2", "b")] });
    const a = (await json(await call("GET", "/api/members", { as: EDITOR }))).find((x: any) => x.member_code === "P-1");
    await call("POST", `/api/registry/members/${a.id}/status`, { as: PASTOR, body: { status_code: "left", event_date: "2026-10-01" } });
    await call("POST", `/api/registry/members/${a.id}/titles`, { as: PASTOR, body: { title_id: 5, start_date: "2026-01-01" } });
    await sync({ people: [person("P-2", "b")] }); // P-1 no longer sent
    await sync({ people: [person("P-1", "a"), person("P-2", "b")] });
    const d = await json(await call("GET", `/api/registry/members/${a.id}`, { as: PASTOR }));
    expect(d.current_status).toBe("left");
    expect(d.titles).toHaveLength(1);
  });

  it("accepts only the five fields (no counselling data can come in)", async () => {
    for (const p of [
      person("P-1", "a", { 메모: "상담 내용" }),
      person("P-1", "a", { birth_date: "1960-01-01" }),
      { ...person("P-1", "a"), name: "" },
      person("bad code!", "a"),
    ]) {
      expect((await sync({ people: [p] })).status).toBe(400);
    }
    expect((await sync({ people: [person("P-1", "a"), person("P-1", "b")] })).status).toBe(400);
    expect((await sync({ people: Array.from({ length: 101 }, (_, i) => person(`P-${i}`, "x")) })).status).toBe(400);
    expect((await sync({ people: [] })).status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM members")).toBe(0);
  });

  it("handles full batches of 100 new people, and a second batch with 100 already known", async () => {
    const batch = (from: number) => Array.from({ length: 100 }, (_, i) => person(`P-${from + i}`, `사람${from + i}`));
    expect(await json(await sync({ people: batch(0) }))).toEqual({ created: 100, updated: 0, unchanged: 0 });
    expect(await json(await sync({ people: batch(100) }))).toEqual({ created: 100, updated: 0, unchanged: 0 });
    expect(await json(await sync({ people: batch(50) }))).toEqual({ created: 0, updated: 0, unchanged: 100 });
    expect(await count("SELECT COUNT(*) AS n FROM member_status_events")).toBe(200);
  });
});
