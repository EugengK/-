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

  it("seeds the nine titles; 서리집사 is a yearly appointment", async () => {
    const t = await json(await call("GET", "/api/registry/titles", { as: PASTOR }));
    expect(t.map((x: any) => x.name)).toEqual(["성도", "청년", "서리집사", "장립집사", "권사", "장로", "전도사", "강도사", "목사"]);
    expect(t.find((x: any) => x.name === "서리집사").term_limited).toBe(true);
    expect(t.find((x: any) => x.name === "장로").term_limited).toBe(false);
  });

  it("only the pastor manages titles", async () => {
    expect((await call("POST", "/api/registry/titles", { as: EDITOR, body: { name: "사모" } })).status).toBe(403);
    const r = await call("POST", "/api/registry/titles", { as: PASTOR, body: { name: "사모" } });
    expect(r.status).toBe(201);
    expect((await call("POST", "/api/registry/titles", { as: PASTOR, body: { name: "사모" } })).status).toBe(409);
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

    const list = await json(await call("GET", "/api/members", { as: PASTOR }));
    expect(list.find((x: any) => x.id === m.id).current_title).toBe("서리집사");

    const exp = await json(await call("GET", `/api/registry/expiring?year=${year}`, { as: PASTOR }));
    expect(exp.map((e: any) => [e.member_name, e.title_name])).toEqual([["홍길동", "서리집사"]]);
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
    const list = await json(await call("GET", "/api/members", { as: PASTOR }));
    expect(list.find((x: any) => x.id === m.id).current_title).toBeNull();
  });
});

describe("attendance status history", () => {
  beforeEach(resetDb);

  it("left -> hidden from giver list; returned -> back; voiding recomputes", async () => {
    await sync({ people: [person("P-9", "떠난분", { registered_on: "2020-01-01" })] });
    const m = (await json(await call("GET", "/api/members", { as: PASTOR }))).find((x: any) => x.member_code === "P-9");
    const left = await json(await call("POST", `/api/registry/members/${m.id}/status`, { as: PASTOR, body: { status_code: "left", event_date: "2026-03-01", note: "타주 이사" } }));
    expect((await json(await call("GET", "/api/members", { as: PASTOR }))).some((x: any) => x.id === m.id)).toBe(false);
    const all = await json(await call("GET", "/api/members?include_inactive=1", { as: PASTOR }));
    expect(all.find((x: any) => x.id === m.id).current_status).toBe("left");

    await call("POST", `/api/registry/members/${m.id}/status`, { as: PASTOR, body: { status_code: "returned", event_date: "2026-09-01" } });
    expect((await json(await call("GET", "/api/members", { as: PASTOR }))).find((x: any) => x.id === m.id).current_status).toBe("returned");

    // An earlier-dated event added later does not override the latest one.
    await call("POST", `/api/registry/members/${m.id}/status`, { as: PASTOR, body: { status_code: "inactive", event_date: "2026-05-01" } });
    expect((await json(await call("GET", "/api/members", { as: PASTOR }))).find((x: any) => x.id === m.id).current_status).toBe("returned");

    // Void "returned" -> the latest is now 'inactive' (still listed); void that too -> 'left' (hidden).
    const detail = await json(await call("GET", `/api/registry/members/${m.id}`, { as: PASTOR }));
    const returned = detail.statuses.find((s: any) => s.status_code === "returned");
    const inactive = detail.statuses.find((s: any) => s.status_code === "inactive");
    await call("POST", `/api/registry/status-events/${returned.id}/void`, { as: PASTOR, body: { reason: "x" } });
    await call("POST", `/api/registry/status-events/${inactive.id}/void`, { as: PASTOR, body: { reason: "x" } });
    expect((await json(await call("GET", "/api/members", { as: PASTOR }))).some((x: any) => x.id === m.id)).toBe(false);
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
    const [dad, kid] = (await json(await call("GET", "/api/members", { as: PASTOR }))).sort((a: any, b: any) => a.member_code.localeCompare(b.member_code));
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
    expect(await json(r1)).toEqual({ created: 2, updated: 0, pending: 0, unchanged: 0, unknown_titles: [] });
    const rows = await db.prepare("SELECT name, member_code, family_code, relation, registered_on, is_active FROM members ORDER BY member_code").all();
    expect(rows.results[0]).toMatchObject({ name: "윤영자", member_code: "P-1", family_code: "F-1", relation: "본인", registered_on: "2026-08-09", is_active: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM member_status_events WHERE status_code = 'registered' AND event_date = '2026-08-09'")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE user_email = 'sheet-sync@system.local' AND action = 'create'")).toBe(2);

    const r2 = await sync({ people: [person("P-1", "윤영자"), person("P-2", "정경남 ", { relation: "배우자" })] });
    expect(await json(r2)).toEqual({ created: 0, updated: 0, pending: 0, unchanged: 2, unknown_titles: [] });
    const r3 = await sync({ people: [person("P-1", "윤영자B")] });
    expect(await json(r3)).toEqual({ created: 0, updated: 1, pending: 0, unchanged: 0, unknown_titles: [] });
    expect(await count("SELECT COUNT(*) AS n FROM members WHERE name = '윤영자B'")).toBe(1);
  });

  it("never marks people as left and keeps titles/status set by the pastor", async () => {
    await sync({ people: [person("P-1", "a"), person("P-2", "b")] });
    const a = (await json(await call("GET", "/api/members", { as: PASTOR }))).find((x: any) => x.member_code === "P-1");
    await call("POST", `/api/registry/members/${a.id}/status`, { as: PASTOR, body: { status_code: "left", event_date: "2026-10-01" } });
    await call("POST", `/api/registry/members/${a.id}/titles`, { as: PASTOR, body: { title_id: 5, start_date: "2026-01-01" } });
    await sync({ people: [person("P-2", "b")] }); // P-1 no longer sent
    await sync({ people: [person("P-1", "a"), person("P-2", "b")] });
    const d = await json(await call("GET", `/api/registry/members/${a.id}`, { as: PASTOR }));
    expect(d.current_status).toBe("left");
    expect(d.titles).toHaveLength(1);
  });

  it("accepts only the seven fields (no counselling data can come in)", async () => {
    for (const p of [
      person("P-1", "a", { 메모: "상담 내용" }),
      person("P-1", "a", { address: "1 Main St" }),
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
    expect(await json(await sync({ people: batch(0) }))).toEqual({ created: 100, updated: 0, pending: 0, unchanged: 0, unknown_titles: [] });
    expect(await json(await sync({ people: batch(100) }))).toEqual({ created: 100, updated: 0, pending: 0, unchanged: 0, unknown_titles: [] });
    expect(await json(await sync({ people: batch(50) }))).toEqual({ created: 0, updated: 0, pending: 0, unchanged: 100, unknown_titles: [] });
    expect(await count("SELECT COUNT(*) AS n FROM member_status_events")).toBe(200);
  });
});

describe("review fixes: no duplicates on first sync, history consistency", () => {
  beforeEach(resetDb);

  it("holds a sheet person whose name matches a hand-entered member, until the pastor decides", async () => {
    const old = await newMember("김철수"); // entered by hand before the sync, may have giving history
    const r = await json(await sync({ people: [person("P-1", "김철수"), person("P-2", "이영희")] }));
    expect(r).toEqual({ created: 1, updated: 0, pending: 1, unchanged: 0, unknown_titles: [] });
    expect(await count("SELECT COUNT(*) AS n FROM members WHERE name = '김철수'")).toBe(1);
    // Re-sending keeps it pending (no duplicate either way).
    expect(await json(await sync({ people: [person("P-1", "김철수")] }))).toMatchObject({ pending: 1, created: 0 });

    const pend = await json(await call("GET", "/api/registry/pending", { as: PASTOR }));
    expect(pend).toHaveLength(1);
    expect(pend[0].candidates.map((c: any) => c.id)).toEqual([old.id]);

    expect((await call("POST", "/api/registry/pending/P-1/link", { as: EDITOR, body: { member_id: old.id } })).status).toBe(403);
    expect((await call("POST", "/api/registry/pending/P-1/link", { as: PASTOR, body: { member_id: old.id } })).status).toBe(200);
    expect(await json(await call("GET", "/api/registry/pending", { as: PASTOR }))).toHaveLength(0);
    const linked = await db.prepare("SELECT member_code, family_code FROM members WHERE id = ?").bind(old.id).first<any>();
    expect(linked).toEqual({ member_code: "P-1", family_code: "F-1" });
    // From now on the sheet updates the same record.
    expect(await json(await sync({ people: [person("P-1", "김철수")] }))).toMatchObject({ unchanged: 1, pending: 0 });
    expect((await call("POST", "/api/registry/pending/P-1/link", { as: PASTOR, body: { member_id: old.id } })).status).toBe(404);
  });

  it("'different person' creates a new member from the pending row", async () => {
    await newMember("박");
    await sync({ people: [person("P-7", "박")] });
    expect((await call("POST", "/api/registry/pending/P-7/create", { as: PASTOR, body: {} })).status).toBe(201);
    expect(await count("SELECT COUNT(*) AS n FROM members WHERE name = '박'")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM member_status_events e JOIN members m ON m.id = e.member_id WHERE m.member_code = 'P-7' AND e.status_code = 'registered'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM sync_pending")).toBe(0);
  });

  it("cannot link to someone already linked", async () => {
    await sync({ people: [person("P-1", "최")] });
    const linkedOne = (await json(await call("GET", "/api/members", { as: PASTOR })))[0];
    await newMember("최");
    await sync({ people: [person("P-2", "최")] });
    expect((await call("POST", "/api/registry/pending/P-2/link", { as: PASTOR, body: { member_id: linkedOne.id } })).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM sync_pending")).toBe(1);
  });

  it("refuses future-dated status events", async () => {
    const m = await newMember("미래");
    const r = await call("POST", `/api/registry/members/${m.id}/status`, { as: PASTOR, body: { status_code: "transferred", event_date: "2099-01-01" } });
    expect(r.status).toBe(400);
    expect((await json(await call("GET", "/api/members", { as: PASTOR }))).some((x: any) => x.id === m.id)).toBe(true);
  });
});

describe("birth date and first title from the sheet; CSV import", () => {
  beforeEach(resetDb);
  const detail = async (code: string) => {
    const m = (await json(await call("GET", "/api/members?include_inactive=1", { as: PASTOR }))).find((x: any) => x.member_code === code);
    return json(await call("GET", `/api/registry/members/${m.id}`, { as: PASTOR }));
  };

  it("stores birth date; the sheet's 직분 becomes the first title (집사 = 서리집사 for this year)", async () => {
    const year = todayInHobart().slice(0, 4);
    const r = await json(await sync({ people: [
      person("P-1", "가", { birth_date: "1960-05-01", title: "장로" }),
      person("P-2", "나", { title: "집사" }),
      person("P-3", "다", { title: "목자" }),
    ] }));
    expect(r).toMatchObject({ created: 3, unknown_titles: ["목자"] });
    const a = await detail("P-1");
    expect(a).toMatchObject({ birth_date: "1960-05-01", current_title: "장로" });
    expect(a.titles[0]).toMatchObject({ title_name: "장로", start_date: "2026-08-09", end_date: null });
    const b = await detail("P-2");
    expect(b.titles[0]).toMatchObject({ title_name: "서리집사", start_date: `${year}-01-01`, end_date: `${year}-12-31` });
    expect((await detail("P-3")).titles).toHaveLength(0);
  });

  it("after the first title, the sheet's 직분 no longer changes anything; a blank birth date never erases one", async () => {
    await sync({ people: [person("P-1", "가", { birth_date: "1960-05-01", title: "권사" })] });
    const r = await json(await sync({ people: [person("P-1", "가", { birth_date: null, title: "장로" })] }));
    expect(r).toMatchObject({ updated: 0, unchanged: 1 });
    const a = await detail("P-1");
    expect(a.birth_date).toBe("1960-05-01");
    expect(a.titles.map((t: any) => t.title_name)).toEqual(["권사"]);
  });

  it("someone known without a title gets the sheet's title once", async () => {
    await sync({ people: [person("P-1", "가")] });
    expect(await json(await sync({ people: [person("P-1", "가", { title: "청년" })] }))).toMatchObject({ updated: 1 });
    expect((await detail("P-1")).current_title).toBe("청년");
  });

  it("rejects impossible birth dates", async () => {
    for (const d of ["1899-12-31", "2099-01-01", "1960-02-30", "01/05/1960"]) {
      expect((await sync({ people: [person("P-1", "가", { birth_date: d })] })).status).toBe(400);
    }
  });

  it("CSV import endpoint: pastor only, same rules, audited as the pastor", async () => {
    const body = { people: [person("P-1", "가", { birth_date: "1990-01-01", title: "청년" })] };
    expect((await call("POST", "/api/registry/import", { as: EDITOR, body })).status).toBe(403);
    const r = await call("POST", "/api/registry/import", { as: PASTOR, body });
    expect(await json(r)).toMatchObject({ created: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE user_email = ? AND table_name = 'members'", PASTOR)).toBe(1);
    expect((await call("POST", "/api/registry/import", { as: PASTOR, body: { people: [person("P-2", "나", { 메모: "x" })] } })).status).toBe(400);
  });

  it("pending people keep their birth date and title when created or linked", async () => {
    const old = await newMember("가");
    await sync({ people: [person("P-1", "가", { birth_date: "1970-03-07", title: "권사" }), person("P-2", "나")] });
    await newMember("나"); // now 나 from the sheet is known (P-2) — unaffected
    await call("POST", "/api/registry/pending/P-1/link", { as: PASTOR, body: { member_id: old.id } });
    const a = await detail("P-1");
    expect(a).toMatchObject({ id: old.id, birth_date: "1970-03-07", current_title: "권사" });
  });
});

describe("church roster import (no IDs) and auto-linking", () => {
  beforeEach(resetDb);
  const roster = (people: unknown[], as = PASTOR) => call("POST", "/api/registry/import-roster", { as, body: { people } });
  const byName = async (name: string) =>
    (await json(await call("GET", "/api/members?include_inactive=1", { as: PASTOR }))).filter((m: any) => m.name === name);

  it("creates people with title, birth date and phone; re-import changes nothing", async () => {
    const people = [
      { name: "가장로", birth_date: "1958-07-10", phone: "0400 000 001", title: "시무장로" },
      { name: "나권사", birth_date: "1960-02-09", title: "시무권사" },
      { name: "다집사", birth_date: "1990-08-09", title: "집사" },
      { name: "라전도사", title: "전도사" },
      { name: "마어린이", birth_date: "2013-02-17", note: "주일학교 Year 7" },
      { name: "바사모", birth_date: "1984-12-21", title: "사모" },
    ];
    const r = await json(await roster(people));
    expect(r).toMatchObject({ created: 6, updated: 0, unchanged: 0, ambiguous: [], unknown_titles: ["사모"] });
    const [a] = await byName("가장로");
    expect(a).toMatchObject({ current_title: "장로", birth_date: "1958-07-10", phone: "0400 000 001", member_code: null, current_status: "registered" });
    expect((await byName("나권사"))[0].current_title).toBe("권사");
    expect((await byName("다집사"))[0].current_title).toBe("서리집사");
    expect((await byName("라전도사"))[0].current_title).toBe("전도사");
    expect((await byName("마어린이"))[0].note).toBe("주일학교 Year 7");
    // Re-import: everyone matched except the person with neither birth date nor phone, who is reported, never guessed.
    expect(await json(await roster(people))).toMatchObject({ created: 0, updated: 0, unchanged: 5, ambiguous: ["라전도사(생년월일·연락처가 없어 같은 분인지 알 수 없음)"] });
    expect(await count("SELECT COUNT(*) AS n FROM members")).toBe(6);
  });

  it("pastor only; rejects other fields", async () => {
    expect((await roster([{ name: "x" }], EDITOR)).status).toBe(403);
    expect((await roster([{ name: "x", 메모: "상담" }])).status).toBe(400);
  });

  it("matches by name + birth date; same name with a different birth date is another person; unsure cases are skipped", async () => {
    await roster([{ name: "김철수", birth_date: "1960-01-01" }]);
    await roster([{ name: "김철수", birth_date: "1970-01-01" }]); // different person
    expect(await byName("김철수")).toHaveLength(2);
    const r = await json(await roster([{ name: "김철수" }])); // no birth date: can't tell which
    expect(r.ambiguous).toEqual(["김철수(생년월일·연락처가 없어 같은 분인지 알 수 없음)"]);
    expect(await byName("김철수")).toHaveLength(2);
  });

  it("never merges into a same-name person without a birth date (could be a different person)", async () => {
    const visitor = await newMember("최지훈"); // hand-entered visitor, maybe with giving
    await call("PATCH", `/api/members/${visitor.id}`, { as: PASTOR, body: { phone: "visitor-phone" } });
    const r = await json(await roster([{ name: "최지훈", birth_date: "2015-03-03", title: "성도" }]));
    expect(r.ambiguous).toEqual(["최지훈(생년월일이 없는 같은 이름이 있음)"]);
    const [v] = await byName("최지훈");
    expect(v).toMatchObject({ phone: "visitor-phone", birth_date: null });
    // Once the pastor records the visitor's real birth date, the roster child is a different person.
    await call("PATCH", `/api/members/${visitor.id}`, { as: PASTOR, body: { birth_date: "1980-01-01" } });
    expect(await json(await roster([{ name: "최지훈", birth_date: "2015-03-03" }]))).toMatchObject({ created: 1 });
  });

  it("without a birth date, matches only on the same phone; never overwrites a known phone", async () => {
    await roster([{ name: "전도사", phone: "0425" }]);
    expect(await json(await roster([{ name: "전도사", phone: "0425", title: "전도사" }]))).toMatchObject({ updated: 1, ambiguous: [] });
    expect(await json(await roster([{ name: "전도사", phone: "0999" }]))).toMatchObject({ ambiguous: ["전도사(생년월일이 없어 같은 분인지 알 수 없음)"] });
    expect((await byName("전도사"))[0].phone).toBe("0425");
  });

  it("same person twice in one file is reported, not merged or crashed; two same-name people with different birth dates are both created", async () => {
    const r = await json(await roster([
      { name: "김민수", birth_date: "1990-01-01" },
      { name: "김민수", birth_date: "1990-01-01", title: "청년" },
      { name: "박철수", birth_date: "1950-01-01", title: "장로" },
      { name: "박철수", birth_date: "1985-01-01" },
    ]));
    expect(r.created).toBe(3);
    expect(r.ambiguous).toEqual(["김민수(파일 안에 같은 분이 두 번)"]);
    expect(await byName("박철수")).toHaveLength(2);
  });

  it("spacing differences are the same name", async () => {
    await roster([{ name: "김 영수", birth_date: "1970-01-01" }]);
    expect(await json(await sync({ people: [person("P-9", "김영수", { birth_date: "1970-01-01" })] }))).toMatchObject({ created: 0, updated: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM members")).toBe(1);
  });

  it("a '-' name row is ignored", async () => {
    expect(await json(await roster([{ name: "-" }]))).toMatchObject({ created: 0, ambiguous: [] });
  });

  it("the sheet sync later links a roster person automatically (same name and birth date)", async () => {
    await roster([{ name: "윤", birth_date: "1960-05-01", title: "성도" }]);
    const [m] = await byName("윤");
    const r = await json(await sync({ people: [person("P-1", "윤", { birth_date: "1960-05-01", title: "권사" })] }));
    expect(r).toMatchObject({ created: 0, updated: 1, pending: 0 });
    const [after] = await byName("윤");
    expect(after).toMatchObject({ id: m.id, member_code: "P-1", family_code: "F-1", current_title: "성도" }); // title kept
    // Same name but no/other birth date -> still held for the pastor.
    await roster([{ name: "정", birth_date: "1970-01-01" }]);
    expect(await json(await sync({ people: [person("P-2", "정", { birth_date: "1971-01-01" })] }))).toMatchObject({ pending: 1 });
  });
});

describe("audit fixes: registry dates and pending clean-up", () => {
  beforeEach(resetDb);

  it("registration dates before 2000 are accepted; future ones are refused", async () => {
    expect((await sync({ people: [person("P-1", "오래된분", { registered_on: "1995-03-01" })] })).status).toBe(200);
    expect((await sync({ people: [person("P-2", "미래", { registered_on: "2090-01-01" })] })).status).toBe(400);
  });

  it("a 1998 ordination and a 1999 status event can be recorded", async () => {
    await sync({ people: [person("P-1", "장로님", { registered_on: "1990-01-01" })] });
    const m = (await json(await call("GET", "/api/members", { as: PASTOR })))[0];
    expect((await call("POST", `/api/registry/members/${m.id}/titles`, { as: PASTOR, body: { title_id: 6, start_date: "1998-05-01" } })).status).toBe(201);
    expect((await call("POST", `/api/registry/members/${m.id}/status`, { as: PASTOR, body: { status_code: "inactive", event_date: "1999-01-01" } })).status).toBe(201);
  });

  it("a pending row resolved automatically later is cleared (no stale 'confirm' item)", async () => {
    const hand = await newMember("송");
    await sync({ people: [person("P-1", "송", { birth_date: "1984-12-21" })] }); // -> pending (hand-entered has no birth date)
    expect(await count("SELECT COUNT(*) AS n FROM sync_pending")).toBe(1);
    await call("PATCH", `/api/members/${hand.id}`, { as: PASTOR, body: { birth_date: "1984-12-21" } });
    expect(await json(await sync({ people: [person("P-1", "송", { birth_date: "1984-12-21" })] }))).toMatchObject({ updated: 1, pending: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM sync_pending")).toBe(0);
  });

  it("birth dates can be set by the pastor, not in the future, and not by editors", async () => {
    const m = await newMember("x");
    expect((await call("PATCH", `/api/members/${m.id}`, { as: PASTOR, body: { birth_date: "2099-01-01" } })).status).toBe(400);
    expect((await call("PATCH", `/api/members/${m.id}`, { as: EDITOR, body: { birth_date: "1990-01-01" } })).status).toBe(403);
    expect((await call("PATCH", `/api/members/${m.id}`, { as: PASTOR, body: { birth_date: "1990-01-01" } })).status).toBe(200);
  });
});

describe("church roster with 교인ID and 가정ID", () => {
  beforeEach(resetDb);
  const roster = (people: unknown[]) => call("POST", "/api/registry/import-roster", { as: PASTOR, body: { people } });
  const byName = async () => Object.fromEntries((await json(await call("GET", "/api/members?include_inactive=1", { as: PASTOR }))).map((m: any) => [m.name, m]));

  it("creates people with their IDs and families; the ID decides on re-import", async () => {
    const r = await json(await roster([
      { member_code: "P-1", family_code: "F-1", name: "가장로", birth_date: "1958-07-10", phone: "0400 000 001", title: "시무장로" },
      { member_code: "P-2", family_code: "F-1", name: "가권사", birth_date: "1960-01-01", title: "시무권사" },
      { member_code: "P-3", family_code: "F-1", name: "가아이", birth_date: "2014-07-28", note: "주일학교 Year 6" },
      { member_code: "P-4", family_code: "F-2", name: "나성도" }, // no birth date: the ID is enough
    ]));
    expect(r).toMatchObject({ created: 4, ambiguous: [] });
    const m = await byName();
    expect(m["가장로"]).toMatchObject({ member_code: "P-1", family_code: "F-1", current_title: "장로" });
    expect(m["가아이"]).toMatchObject({ family_code: "F-1", current_title: null, note: "주일학교 Year 6" });
    const detail = await json(await call("GET", `/api/registry/members/${m["가장로"].id}`, { as: PASTOR }));
    expect(detail.family.map((f: any) => f.name).sort()).toEqual(["가권사", "가아이"]);
    // same file again: nothing changes; a different name under a known ID is refused, not merged
    expect(await json(await roster([{ member_code: "P-4", family_code: "F-2", name: "나성도" }]))).toMatchObject({ created: 0, unchanged: 1 });
    const clash = await json(await roster([{ member_code: "P-4", name: "다른사람" }]));
    expect(clash.created).toBe(0);
    expect(clash.ambiguous[0]).toContain("P-4");
  });

  it("skips an ID used twice in one file and links a person who was added before without an ID", async () => {
    await json(await roster([{ name: "김채우", birth_date: "2013-02-17" }])); // earlier roster, no IDs
    const r = await json(await roster([
      { member_code: "P-A02", family_code: "F-A", name: "송은정", birth_date: "1984-12-21" },
      { member_code: "P-A02", family_code: "F-A", name: "김채우", birth_date: "2013-02-17" },
      { member_code: "P-A05", family_code: "F-A", name: "김하라", birth_date: "2017-08-16" },
    ]));
    expect(r.created).toBe(1); // 김하라 only
    expect(r.ambiguous).toHaveLength(2); // both rows with the doubled ID
    expect(r.ambiguous.every((a: string) => a.includes("P-A02"))).toBe(true);
    // after the file is fixed, the earlier 김채우 gets the ID instead of a duplicate being made
    const fixed = await json(await roster([{ member_code: "P-A03", family_code: "F-A", name: "김채우", birth_date: "2013-02-17" }]));
    expect(fixed).toMatchObject({ created: 0, updated: 1 });
    const m = await byName();
    expect(m["김채우"]).toMatchObject({ member_code: "P-A03", family_code: "F-A" });
    expect(Object.keys(m).filter((n) => n === "김채우")).toHaveLength(1);
  });
});

describe("giving per member and the 목사 title", () => {
  beforeEach(resetDb);

  it("totals active offerings per member for a period; pastor only", async () => {
    await call("POST", "/api/registry/import-roster", { as: PASTOR, body: { people: [
      { member_code: "P-1", family_code: "F-1", name: "가목사", title: "담임목사" },
      { member_code: "P-2", family_code: "F-1", name: "가사모" },
    ] } });
    const m = Object.fromEntries((await json(await call("GET", "/api/members", { as: PASTOR }))).map((x: any) => [x.name, x]));
    expect(m["가목사"].current_title).toBe("목사"); // 담임목사 in the roster = 목사
    const post = (entries: unknown[], date = "2026-03-01") => call("POST", "/api/offerings", { as: EDITOR, body: { offering_date: date, entries } });
    await post([
      { fund_type_id: 1, amount_cents: 1000, method: "cash", member_id: m["가목사"].id },
      { fund_type_id: 2, amount_cents: 2500, method: "online", member_id: m["가목사"].id },
      { fund_type_id: 1, amount_cents: 700, method: "cash", member_id: m["가사모"].id },
      { fund_type_id: 1, amount_cents: 999, method: "cash" }, // anonymous: not counted
      { fund_type_id: 1, amount_cents: 500, method: "cash", visitor_from: "시드니" }, // visitor: not counted
    ]);
    const [late] = await json(await post([{ fund_type_id: 1, amount_cents: 4000, method: "cash", member_id: m["가사모"].id }], "2027-01-02"));
    const voided = (await json(await post([{ fund_type_id: 1, amount_cents: 300, method: "cash", member_id: m["가사모"].id }])))[0];
    await call("POST", `/api/offerings/${voided.id}/void`, { as: EDITOR, body: { reason: "오입력" } });
    expect(late.id).toBeGreaterThan(0);

    const g = await json(await call("GET", "/api/registry/giving?from=2026-01-01&to=2026-12-31", { as: PASTOR }));
    const by = Object.fromEntries(g.map((x: any) => [x.member_id, x.total_cents]));
    expect(by).toEqual({ [m["가목사"].id]: 3500, [m["가사모"].id]: 700 });
    expect((await call("GET", "/api/registry/giving?from=2026-01-01&to=2026-12-31", { as: EDITOR })).status).toBe(403);
    expect((await call("GET", "/api/registry/giving?from=2026-12-31&to=2026-01-01", { as: PASTOR })).status).toBe(400);
  });
});
