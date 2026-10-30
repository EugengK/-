import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { ReaderFailed, ReaderUnavailable, geminiReader, normaliseReceipt, type ReceiptReader } from "../src/ocr";
import type { Env, TokenVerifier } from "../src/types";
import { EDITOR, PASTOR, app as defaultApp, resetDb } from "./helpers";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const verifier: TokenVerifier = async (t) => (t.startsWith("tok:") ? t.slice(4) : null);

function send(a: ReturnType<typeof createApp>, body: Uint8Array, as: string | null = EDITOR, type = "image/jpeg") {
  const headers: Record<string, string> = { "Content-Type": type };
  if (as) headers["Cf-Access-Jwt-Assertion"] = `tok:${as}`;
  return a.request("https://finance.example.org/api/receipts/read", { method: "POST", headers, body: body as BodyInit }, env);
}

describe("normaliseReceipt", () => {
  it("turns dollars into cents and keeps what is plausible", () => {
    const r = normaliseReceipt({ store: " Coles Hobart ", date: "2026-10-30", total: 82.4, gst: "1.23", items: [{ name: "Milk 2L", amount: 3.1 }, { name: "", amount: 1 }] }, "2026-10-30");
    expect(r).toEqual({ vendor: "Coles Hobart", date: "2026-10-30", total_cents: 8240, gst_cents: 123, items: [{ name: "Milk 2L", amount_cents: 310 }], warnings: [] });
  });

  it("drops implausible values and says why instead of guessing", () => {
    const r = normaliseReceipt({ store: null, date: "2026-12-25", total: 10, gst: 20, items: "x", notes: "faded at the bottom" }, "2026-10-30");
    expect(r.date).toBeNull(); // in the future
    expect(r.gst_cents).toBeNull(); // more than the total
    expect(r.total_cents).toBe(1000);
    expect(r.items).toEqual([]);
    expect(r.warnings).toEqual(["GST 금액이 맞지 않아 비워 두었습니다.", "날짜를 읽지 못했습니다.", "faded at the bottom"]);
    expect(normaliseReceipt("nonsense").total_cents).toBeNull();
    expect(normaliseReceipt({ total: -5 }).total_cents).toBeNull();
    expect(normaliseReceipt({ date: "2026-02-30" }).date).toBeNull();
  });
});

describe("geminiReader", () => {
  const e = (extra: Partial<Env> = {}) => ({ ...env, GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-test", ...extra }) as Env;

  it("sends the image inline with the key in a header and reads the JSON answer", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      const text = '```json\n{"store":"Coles","date":"2026-10-30","total":45.5,"gst":0.5,"items":[]}\n```';
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await geminiReader(fakeFetch)(e(), JPEG, "image/jpeg");
    expect(r).toMatchObject({ vendor: "Coles", total_cents: 4550, gst_cents: 50 });
    expect(seen!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect((seen!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    expect(seen!.url).not.toContain("test-key"); // never in the URL (logs)
    const body = JSON.parse(seen!.init.body as string);
    expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: "image/jpeg", data: btoa(String.fromCharCode(...JPEG)) });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("without a key it is 'not set up'; a failed or unreadable answer is 'failed'", async () => {
    const never = (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch;
    await expect(geminiReader(never)(e({ GEMINI_API_KEY: undefined }), JPEG, "image/jpeg")).rejects.toBeInstanceOf(ReaderUnavailable);
    const status = (async () => new Response("quota", { status: 429 })) as unknown as typeof fetch;
    await expect(geminiReader(status)(e(), JPEG, "image/jpeg")).rejects.toBeInstanceOf(ReaderFailed);
    const junk = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "sorry" }] } }] }))) as unknown as typeof fetch;
    await expect(geminiReader(junk)(e(), JPEG, "image/jpeg")).rejects.toBeInstanceOf(ReaderFailed);
  });
});

describe("POST /api/receipts/read", () => {
  beforeEach(resetDb);

  it("finance editors send a photo and get the values back; nothing is saved", async () => {
    let got: { type: string; size: number } | null = null;
    const fake: ReceiptReader = async (_env, bytes, mime) => {
      got = { type: mime, size: bytes.length };
      return normaliseReceipt({ store: "Woolworths", total: 12.5 });
    };
    const a = createApp(verifier, fake);
    const r = await send(a, JPEG);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ vendor: "Woolworths", total_cents: 1250 });
    expect(got).toEqual({ type: "image/jpeg", size: JPEG.length });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses").first<{ n: number }>())!.n).toBe(0);
  });

  it("checks who and what: editors only, real images only; clear errors when not set up or failing", async () => {
    const a = createApp(verifier, async () => normaliseReceipt({}));
    expect((await send(a, JPEG, PASTOR)).status).toBe(403);
    expect((await send(a, JPEG, null)).status).toBe(401);
    expect((await send(a, new TextEncoder().encode("<html>"), EDITOR)).status).toBe(415);
    expect((await send(a, JPEG, EDITOR, "text/plain")).status).toBe(415);
    // the real reader with no key configured (as in tests): 503 with a plain message
    const unset = await send(defaultApp as ReturnType<typeof createApp>, JPEG);
    expect(unset.status).toBe(503);
    const failing = createApp(verifier, async () => { throw new ReaderFailed("x"); });
    const f = await send(failing, JPEG);
    expect(f.status).toBe(502);
    expect(((await f.json()) as { error: string }).error).toContain("직접 입력");
  });
});
