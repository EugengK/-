import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { EDITOR, PASTOR, app, call, db, json, resetDb } from "./helpers";

const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

function upload(expenseId: number, bytes: Uint8Array, opts: { as?: string; type?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": opts.type ?? "image/jpeg" };
  if (opts.as ?? EDITOR) headers["Cf-Access-Jwt-Assertion"] = `tok:${opts.as ?? EDITOR}`;
  if (opts.origin) headers.Origin = opts.origin;
  return app.request(`https://finance.example.org/api/expenses/${expenseId}/attachments`, { method: "POST", headers, body: bytes as BodyInit }, env);
}

async function expense() {
  return json(await call("POST", "/api/expenses", { as: EDITOR, body: { expense_date: "2026-10-20", vendor: "Coles", total_cents: 4550, account: "cash" } }));
}

describe("receipt photos", () => {
  beforeEach(resetDb);

  it("stores a photo in R2, lists it, serves it back with its real type, and audits it", async () => {
    const e = await expense();
    const r = await upload(e.id, JPEG);
    expect(r.status).toBe(201);
    const a = await json(r);
    expect(a).toMatchObject({ expense_id: e.id, content_type: "image/jpeg", size_bytes: JPEG.length, status: "active", created_by_name: "기록1" });

    const list = await json(await call("GET", `/api/expenses/${e.id}/attachments`, { as: PASTOR }));
    expect(list.map((x: any) => x.id)).toEqual([a.id]);
    const [row] = await json(await call("GET", "/api/expenses?from=2026-10-01&to=2026-10-31", { as: PASTOR }));
    expect(row.photo_count).toBe(1);

    const img = await call("GET", `/api/attachments/${a.id}`, { as: PASTOR });
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/jpeg");
    expect(img.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(img.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'expense_attachments' AND action = 'create'")).toBe(1);
    const key = (await env.DB.prepare("SELECT r2_key FROM expense_attachments WHERE id = ?").bind(a.id).first<{ r2_key: string }>())!.r2_key;
    expect(await env.RECEIPTS.head(key)).not.toBeNull();
  });

  it("decides the type from the bytes, not the header; refuses non-images, empty and oversized bodies", async () => {
    const e = await expense();
    const png = await json(await upload(e.id, PNG, { type: "image/jpeg" })); // header lies, bytes win
    expect(png.content_type).toBe("image/png");
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect((await upload(e.id, html)).status).toBe(415);
    expect((await upload(e.id, new Uint8Array())).status).toBe(400);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG);
    expect((await upload(e.id, big)).status).toBe(413);
    expect(await count("SELECT COUNT(*) AS n FROM expense_attachments")).toBe(1);
  });

  it("only finance editors upload or remove; same-origin only; not on voided or missing expenses", async () => {
    const e = await expense();
    expect((await upload(e.id, JPEG, { as: PASTOR })).status).toBe(403);
    expect((await upload(e.id, JPEG, { origin: "https://evil.example" })).status).toBe(403);
    expect((await upload(e.id, JPEG, { type: "text/plain" })).status).toBe(415);
    expect((await upload(99999, JPEG)).status).toBe(404);
    // only the upload path accepts an image body
    const elsewhere = await app.request("https://finance.example.org/api/expenses", {
      method: "POST", headers: { "Content-Type": "image/jpeg", "Cf-Access-Jwt-Assertion": `tok:${EDITOR}` }, body: JPEG as BodyInit,
    }, env);
    expect(elsewhere.status).toBe(415);
    await call("POST", `/api/expenses/${e.id}/void`, { as: EDITOR, body: { reason: "중복" } });
    expect((await upload(e.id, JPEG)).status).toBe(409);
  });

  it("a wrong photo is voided with a reason, never deleted; voided photos drop out of the list and count", async () => {
    const e = await expense();
    const a = await json(await upload(e.id, JPEG));
    expect((await call("POST", `/api/attachments/${a.id}/void`, { as: PASTOR, body: { reason: "x" } })).status).toBe(403);
    expect((await call("POST", `/api/attachments/${a.id}/void`, { as: EDITOR, body: {} })).status).toBe(400);
    expect((await call("POST", `/api/attachments/${a.id}/void`, { as: EDITOR, body: { reason: "다른 영수증" } })).status).toBe(200);
    expect((await call("POST", `/api/attachments/${a.id}/void`, { as: EDITOR, body: { reason: "again" } })).status).toBe(409);
    expect(await json(await call("GET", `/api/expenses/${e.id}/attachments`, { as: EDITOR }))).toHaveLength(0);
    expect(await json(await call("GET", `/api/expenses/${e.id}/attachments?include_void=1`, { as: EDITOR }))).toHaveLength(1);
    const [row] = await json(await call("GET", "/api/expenses?from=2026-10-01&to=2026-10-31", { as: EDITOR }));
    expect(row.photo_count).toBe(0);
    expect((await call("GET", `/api/attachments/${a.id}`, { as: EDITOR })).status).toBe(200); // still viewable for the record
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE table_name = 'expense_attachments' AND action = 'void'")).toBe(1);
  });

  it("caps photos per expense; requires login to view", async () => {
    const e = await expense();
    for (let i = 0; i < 10; i++) expect((await upload(e.id, JPEG)).status).toBe(201);
    expect((await upload(e.id, JPEG)).status).toBe(409);
    const [a] = await json(await call("GET", `/api/expenses/${e.id}/attachments`, { as: EDITOR }));
    expect((await call("GET", `/api/attachments/${a.id}`)).status).toBe(401);
    expect((await call("GET", "/api/attachments/99999", { as: EDITOR })).status).toBe(404);
  });

  it("the expenses CSV counts the photos", async () => {
    const e = await expense();
    await upload(e.id, JPEG);
    const r = await call("GET", "/api/reports/expenses.csv?from=2026-10-01&to=2026-10-31", { as: PASTOR });
    const lines = new TextDecoder().decode(await r.arrayBuffer()).trim().split("\r\n");
    expect(lines[0]).toContain(",영수증 사진(장),");
    expect(lines[1]).toContain(",1,");
  });
});
