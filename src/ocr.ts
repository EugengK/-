import { todayInHobart } from "./dates";
import { addDays } from "./schedule";
import type { Env } from "./types";
import { isRealDate } from "./validation";

/** What was read from a receipt photo. Anything not clearly readable is null; people confirm before saving. */
export interface ReceiptRead {
  vendor: string | null;
  date: string | null;
  total_cents: number | null;
  gst_cents: number | null;
  items: { name: string; amount_cents: number | null }[];
  warnings: string[];
}

/** Reads a receipt image. Injectable so tests (and a later switch of provider) don't need the network. */
export type ReceiptReader = (env: Env, bytes: Uint8Array, mime: string) => Promise<ReceiptRead>;

export class ReaderUnavailable extends Error {}
export class ReaderFailed extends Error {}

const PROMPT = `This is a photo of a shop receipt from Australia (for example Coles, Woolworths, Aldi, Bunnings, Officeworks, Kmart).
Reply with JSON only, exactly this shape:
{"store": string|null, "date": "YYYY-MM-DD"|null, "total": number|null, "gst": number|null, "items": [{"name": string, "amount": number|null}], "notes": string|null}
- store: the shop name as printed (e.g. "Coles Hobart").
- date: the purchase date. Australian receipts write dates day/month/year.
- total: the amount actually paid in AUD (after discounts), as a number like 82.4.
- gst: the GST amount printed on the receipt (e.g. "GST included in total", "Total includes GST of"). null if not printed.
- items: each purchased line with its price; keep the item names as printed.
- notes: anything unclear, otherwise null.
Use null when a value is not clearly readable. Never guess a number.`;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const toCents = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** Checks what the model returned; drops anything implausible and says why. */
export function normaliseReceipt(raw: unknown, today = todayInHobart()): ReceiptRead {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const warnings: string[] = [];
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.normalize("NFC").trim().slice(0, max) : null);

  let total = toCents(r.total);
  if (total !== null && (total <= 0 || total > 100_000_000)) {
    warnings.push("합계를 읽지 못했습니다.");
    total = null;
  }
  let gst = toCents(r.gst);
  if (gst !== null && (gst < 0 || (total !== null && gst > total))) {
    warnings.push("GST 금액이 맞지 않아 비워 두었습니다.");
    gst = null;
  }
  let date = text(r.date, 10);
  if (date !== null && (!isRealDate(date) || date < "2000-01-01" || date > addDays(today, 1))) {
    warnings.push("날짜를 읽지 못했습니다.");
    date = null;
  }
  const items = (Array.isArray(r.items) ? r.items : [])
    .slice(0, 50)
    .map((it) => {
      const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
      return { name: text(o.name, 60) ?? "", amount_cents: toCents(o.amount) };
    })
    .filter((it) => it.name);
  const notes = text(r.notes, 200);
  if (notes) warnings.push(notes);
  return { vendor: text(r.store, 100), date, total_cents: total, gst_cents: gst, items, warnings };
}

/** Google Gemini (paid tier: prompts and images are not used to improve Google's products). */
export function geminiReader(fetchFn: typeof fetch = fetch): ReceiptReader {
  return async (env, bytes, mime) => {
    if (!env.GEMINI_API_KEY) throw new ReaderUnavailable("영수증 자동 읽기가 아직 설정되지 않았습니다. 금액을 직접 입력하세요.");
    const model = env.GEMINI_MODEL || "gemini-3.5-flash";
    let res: Response;
    try {
      res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: base64(bytes) } }, { text: PROMPT }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
        signal: AbortSignal.timeout(45000),
      });
    } catch (err) {
      throw new ReaderFailed(`연결 실패: ${err instanceof Error ? err.name : "unknown"}`);
    }
    if (!res.ok) {
      // The key never appears in the error; the body is Google's error message.
      throw new ReaderFailed(`Gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    }
    const data = (await res.json().catch(() => null)) as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null;
    const out = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      throw new ReaderFailed("응답을 읽을 수 없습니다.");
    }
    return normaliseReceipt(parsed);
  };
}
