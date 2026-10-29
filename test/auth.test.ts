import { env } from "cloudflare:workers";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/auth";
import { EDITOR, PASTOR, call, db, json, resetDb } from "./helpers";

const TEAM = "church.cloudflareaccess.com";
const AUD = "aud-123";

async function setup() {
  const good = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (
    key: CryptoKey,
    claims: Record<string, unknown> = { email: "Editor1@Example.com" },
    over: { iss?: string; aud?: string; exp?: string | number } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(over.iss ?? `https://${TEAM}`)
      .setAudience(over.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(over.exp ?? "5m")
      .sign(key);
  return { good, other, keys, sign };
}

describe("verifyAccessJwt", () => {
  it("accepts a valid token and lower-cases the email", async () => {
    const { good, keys, sign } = await setup();
    expect(await verifyAccessJwt(await sign(good.privateKey), { teamDomain: TEAM, aud: AUD, keys })).toBe(
      "editor1@example.com",
    );
  });

  it("rejects wrong signature, audience, issuer, expiry, missing email and garbage", async () => {
    const { good, other, keys, sign } = await setup();
    const opts = { teamDomain: TEAM, aud: AUD, keys };
    expect(await verifyAccessJwt(await sign(other.privateKey), opts)).toBeNull();
    expect(await verifyAccessJwt(await sign(good.privateKey, undefined, { aud: "someone-else" }), opts)).toBeNull();
    expect(await verifyAccessJwt(await sign(good.privateKey, undefined, { iss: "https://evil.example" }), opts)).toBeNull();
    expect(await verifyAccessJwt(await sign(good.privateKey, undefined, { exp: Math.floor(Date.now() / 1000) - 60 }), opts)).toBeNull();
    expect(await verifyAccessJwt(await sign(good.privateKey, { common_name: "service-token" }), opts)).toBeNull();
    expect(await verifyAccessJwt("not.a.jwt", opts)).toBeNull();
    expect(await verifyAccessJwt("", opts)).toBeNull();
  });

  it("rejects an unsigned (alg=none) token", async () => {
    const { keys } = await setup();
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
    const token = `${b64({ alg: "none" })}.${b64({ email: EDITOR, iss: `https://${TEAM}`, aud: AUD })}.`;
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, keys })).toBeNull();
  });
});

describe("authentication and authorization", () => {
  beforeEach(resetDb);

  it("health check is open", async () => {
    expect((await call("GET", "/api/health")).status).toBe(200);
  });

  it("returns 401 without a token or with an invalid one", async () => {
    expect((await call("GET", "/api/me")).status).toBe(401);
    expect((await call("GET", "/api/me", { headers: { "Cf-Access-Jwt-Assertion": "garbage" } })).status).toBe(401);
    expect((await call("GET", "/api/fund-types")).status).toBe(401);
  });

  it("returns 403 for a valid login that is not a registered user", async () => {
    expect((await call("GET", "/api/me", { as: "stranger@example.com" })).status).toBe(403);
  });

  it("returns 403 for a deactivated user", async () => {
    await db.prepare("UPDATE users SET is_active = 0 WHERE email = ?").bind(EDITOR).run();
    expect((await call("GET", "/api/me", { as: EDITOR })).status).toBe(403);
  });

  it("matches the registered email regardless of case", async () => {
    const res = await call("GET", "/api/me", { as: EDITOR.toUpperCase() });
    expect(res.status).toBe(200);
    expect((await json(res)).role).toBe("editor");
  });

  it("lets a viewer read finance but not record it; the lists everyone picks from are the pastor's", async () => {
    expect((await call("GET", "/api/fund-types", { as: PASTOR })).status).toBe(200);
    expect((await call("GET", "/api/audit-log", { as: PASTOR })).status).toBe(200);
    expect((await call("POST", "/api/offerings", { as: PASTOR, body: {} })).status).toBe(403);
    expect((await call("POST", "/api/expenses", { as: PASTOR, body: {} })).status).toBe(403);
    // reports, the change log and opening balances are the pastor's
    expect((await call("GET", "/api/audit-log", { as: EDITOR })).status).toBe(403);
    expect((await call("GET", "/api/reports/summary?from=2026-01-01&to=2026-12-31", { as: EDITOR })).status).toBe(403);
    expect((await call("POST", "/api/opening-balances", { as: EDITOR, body: {} })).status).toBe(403);
    // finance editors pick from the lists but cannot change them
    for (const path of ["/api/fund-types", "/api/departments", "/api/expense-categories"]) {
      expect((await call("POST", path, { as: EDITOR, body: { name: "특별" } })).status).toBe(403);
    }
    expect((await call("PATCH", "/api/fund-types/1", { as: EDITOR, body: { name: "x" } })).status).toBe(403);
    expect((await call("POST", "/api/registry/titles", { as: EDITOR, body: { name: "x" } })).status).toBe(403);
    // Nothing was written.
    const n = await db.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("denies unknown write methods to viewers too", async () => {
    expect((await call("DELETE", "/api/offerings/1", { as: PASTOR })).status).toBe(403);
    expect((await call("PUT", "/api/expenses/1", { as: PASTOR, body: {} })).status).toBe(403);
    expect((await call("DELETE", "/api/fund-types/1", { as: EDITOR })).status).toBe(403);
  });

  it("blocks cross-site writes (foreign or opaque Origin) and non-JSON bodies", async () => {
    const body = { name: "특별헌금" };
    const foreign = await call("POST", "/api/fund-types", { as: PASTOR, body, headers: { Origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    const opaque = await call("POST", "/api/fund-types", { as: PASTOR, body, headers: { Origin: "null" } });
    expect(opaque.status).toBe(403);
    const form = await call("POST", "/api/fund-types", {
      as: PASTOR,
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(415);
    const same = await call("POST", "/api/fund-types", {
      as: PASTOR,
      body,
      headers: { Origin: "https://finance.example.org" },
    });
    expect(same.status).toBe(201);
  });
});

describe("local development login", () => {
  beforeEach(resetDb);

  const base = { DB: env.DB, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
  const callAt = (host: string, e: typeof env) =>
    import("./helpers").then(({ app }) => app.request(`http://${host}/api/me`, {}, e));

  it("works only when ENVIRONMENT=development and the host is localhost", async () => {
    const dev = { ...base, ENVIRONMENT: "development", DEV_AUTH_EMAIL: EDITOR } as typeof env;
    expect((await callAt("localhost:8787", dev)).status).toBe(200);
    expect((await callAt("127.0.0.1:8787", dev)).status).toBe(200);
    // Same config but reached through a real hostname -> shortcut ignored.
    expect((await callAt("finance.example.org", dev)).status).toBe(401);
    // Production env with DEV_AUTH_EMAIL accidentally set -> shortcut ignored even on localhost.
    const prod = { ...base, ENVIRONMENT: "production", DEV_AUTH_EMAIL: EDITOR } as typeof env;
    expect((await callAt("localhost:8787", prod)).status).toBe(401);
  });
});
