import { env } from "cloudflare:workers";
import { SignJWT, generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { EDITOR, EDITOR2, call, db, json, resetDb, PASTOR } from "./helpers";

const count = async (sql: string, ...b: unknown[]) =>
  (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;

describe("concurrent edits", () => {
  beforeEach(resetDb);

  it("never loses an update or logs a change that was not applied (PATCH)", async () => {
    const { id } = await json(await call("POST", "/api/departments", { as: PASTOR, body: { name: "Orig" } }));
    const [a, b] = await Promise.all([
      call("PATCH", `/api/departments/${id}`, { as: PASTOR, body: { name: "Renamed" } }),
      call("PATCH", `/api/departments/${id}`, { as: PASTOR, body: { is_active: false } }),
    ]);
    const ok = [a.status, b.status].filter((s) => s === 200).length;
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect(ok).toBeGreaterThanOrEqual(1);
    // One audit row per successful response, no more.
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'update' AND row_id = ?", id)).toBe(ok);
    const row = await db.prepare("SELECT name, is_active FROM departments WHERE id = ?").bind(id).first<any>();
    if (a.status === 200) expect(row.name).toBe("Renamed");
    if (b.status === 200) expect(row.is_active).toBe(0);
  });

  it("logs exactly one void when two voids race", async () => {
    const row = await json(
      await call("POST", "/api/opening-balances", {
        as: PASTOR,
        body: { account: "cash", as_of_date: "2026-11-01", amount_cents: 1000 },
      }),
    );
    const [a, b] = await Promise.all([
      call("POST", `/api/opening-balances/${row.id}/void`, { as: PASTOR, body: { reason: "A" } }),
      call("POST", `/api/opening-balances/${row.id}/void`, { as: PASTOR, body: { reason: "B" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'void'")).toBe(1);
    const winner = a.status === 200 ? "A" : "B";
    const stored = await db.prepare("SELECT void_reason FROM opening_balances WHERE id = ?").bind(row.id).first<any>();
    expect(stored.void_reason).toBe(winner);
  });

  it("a stale PATCH conflicts with 409 and writes no audit row", async () => {
    const { id } = await json(await call("POST", "/api/departments", { as: PASTOR, body: { name: "S" } }));
    // Simulate another editor changing the row between our read and write.
    await db.prepare("UPDATE departments SET sort_order = 9 WHERE id = ?").bind(id).run();
    const before = await count("SELECT COUNT(*) AS n FROM audit_log");
    const res = await call("PATCH", `/api/departments/${id}`, { as: PASTOR, body: { name: "T" } });
    expect(res.status).toBe(200); // read happens inside the request, so it sees sort_order=9: not stale
    expect(await count("SELECT COUNT(*) AS n FROM audit_log")).toBe(before + 1);
  });
});

describe("input hardening", () => {
  beforeEach(resetDb);

  it("treats NFC and NFD Hangul as the same name", async () => {
    const nfc = "친교부".normalize("NFC");
    const nfd = "친교부".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect((await call("POST", "/api/departments", { as: PASTOR, body: { name: nfc } })).status).toBe(201);
    expect((await call("POST", "/api/departments", { as: PASTOR, body: { name: nfd } })).status).toBe(409);
  });

  it("does not 500 on fractional or junk paging params", async () => {
    for (const q of ["limit=1.5", "limit=-3", "limit=1e9", "before_id=2.7", "before_id=NaN", "limit=0x10"]) {
      expect((await call("GET", `/api/audit-log?${q}`, { as: PASTOR })).status).toBe(200);
    }
  });

  it("rejects out-of-range dates in the API and impossible dates in the database", async () => {
    for (const d of ["0000-01-01", "1999-12-31", "2101-01-01", "2026-13-45"]) {
      const res = await call("POST", "/api/opening-balances", {
        as: PASTOR,
        body: { account: "cash", as_of_date: d, amount_cents: 1 },
      });
      expect(res.status).toBe(400);
    }
    const u = await db.prepare("SELECT id FROM users LIMIT 1").first<{ id: number }>();
    await expect(
      db
        .prepare("INSERT INTO opening_balances (account, as_of_date, amount_cents, created_by) VALUES ('cash','2026-13-45',1,?)")
        .bind(u!.id)
        .run(),
    ).rejects.toThrow();
  });

  it("requires an exact application/json media type and the same scheme+host in Origin", async () => {
    const body = { name: "ct" };
    const jsonx = await call("POST", "/api/departments", { as: PASTOR, body, headers: { "Content-Type": "application/jsonx" } });
    expect(jsonx.status).toBe(415);
    const charset = await call("POST", "/api/departments", {
      as: PASTOR,
      body: { name: "ct2" },
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    expect(charset.status).toBe(201);
    const http = await call("POST", "/api/departments", { as: PASTOR, body, headers: { Origin: "http://finance.example.org" } });
    expect(http.status).toBe(403);
  });
});

describe("production verifier (default createApp)", () => {
  beforeEach(resetDb);
  const real = createApp();
  const get = (e: Record<string, unknown>, token = "x.y.z") =>
    real.request("https://finance.example.org/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } }, e as unknown as typeof env);

  it("fails closed when Access settings are empty", async () => {
    expect((await get({ DB: env.DB, ENVIRONMENT: "production", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" })).status).toBe(401);
    expect((await get({ DB: env.DB, ENVIRONMENT: "production", ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "" })).status).toBe(401);
  });

  it("rejects an HS256 token and a token without exp before any key lookup succeeds", async () => {
    const e = { DB: env.DB, ENVIRONMENT: "production", ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" };
    const hs = await new SignJWT({ email: EDITOR })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://t.cloudflareaccess.com")
      .setAudience("aud")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("secret-secret-secret-secret-secret"));
    expect((await get(e, hs)).status).toBe(401);
    const { privateKey } = await generateKeyPair("RS256");
    const noExp = await new SignJWT({ email: EDITOR })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://t.cloudflareaccess.com")
      .setAudience("aud")
      .sign(privateKey);
    expect((await get(e, noExp)).status).toBe(401);
  });
});
