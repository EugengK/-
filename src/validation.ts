import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const isoDate = z
  .string()
  .refine((v) => isRealDate(v) && v >= "2000-01-01" && v <= "2100-12-31", "2000~2100년 사이의 실제 날짜(YYYY-MM-DD)여야 합니다.");

// NFC so visually identical Hangul typed on different devices counts as one name.
export const name = z.string().transform((v) => v.normalize("NFC")).pipe(z.string().trim().min(1, "이름을 입력하세요.").max(50, "50자 이하로 입력하세요."));

/** Whole cents only; capped so JSON numbers stay exact. */
export const cents = z.number().int("센트 단위 정수여야 합니다.").min(-1e11).max(1e11);

export const reason = z
  .string()
  .transform((v) => v.normalize("NFC"))
  .pipe(z.string().trim().min(1, "사유를 입력하세요.").max(300));

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "요청 내용을 읽을 수 없습니다." });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length ? `${issue.path.join(".")}: ` : "";
    throw new HTTPException(400, { message: `${where}${issue?.message ?? "잘못된 입력입니다."}` });
  }
  return parsed.data;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
