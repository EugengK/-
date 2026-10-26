import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import { todayInHobart } from "../dates";
import type { AppEnv, AppUser } from "../types";
import { isoDate, parseBody } from "../validation";

/**
 * Receives people from the pastor's 목양 sheet (Apps Script). Only these five fields are accepted;
 * anything else in the payload is rejected, so counselling data can't arrive here by mistake.
 * Adds new people and updates name/family/relation of known ones. Never deletes or marks anyone
 * as left: attendance is managed in the registry by the pastor.
 */
// ~3 statements per new person; 100 keeps one request well under D1's per-request query limit.
// The sheet script sends larger lists in chunks of this size.
const MAX_PEOPLE = 100;

const personSchema = z
  .object({
    member_code: z.string().trim().regex(/^[A-Za-z0-9-]{3,40}$/, "교인ID 형식이 올바르지 않습니다."),
    family_code: z.string().trim().regex(/^[A-Za-z0-9-]{3,40}$/).nullable().optional(),
    name: z.string().transform((v) => v.normalize("NFC").trim()).pipe(z.string().min(1).max(50)),
    relation: z.string().transform((v) => v.normalize("NFC").trim()).pipe(z.string().max(20)).nullable().optional(),
    registered_on: isoDate.nullable().optional(),
  })
  .strict();

const syncSchema = z.object({ people: z.array(personSchema).min(1).max(MAX_PEOPLE) }).strict();

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Constant-time check of the shared secret (both sides hashed, so lengths never leak). */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]).then((h) => h.map((x) => new Uint8Array(x)));
  let diff = 0;
  for (let i = 0; i < a!.length; i++) diff |= a![i]! ^ b![i]!;
  return diff === 0;
}

interface Existing {
  id: number;
  member_code: string;
  name: string;
  family_code: string | null;
  relation: string | null;
}

export const syncRoutes = new Hono<AppEnv>();

syncRoutes.post("/", async (c) => {
  const expected = c.env.SYNC_TOKEN;
  if (!expected || expected.length < 32) {
    throw new HTTPException(503, { message: "시트 연동이 설정되지 않았습니다." });
  }
  const auth = c.req.header("Authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!given || !(await tokenMatches(given, expected))) {
    throw new HTTPException(401, { message: "연동 토큰이 올바르지 않습니다." });
  }
  const type = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HTTPException(415, { message: "JSON 형식으로 요청해야 합니다." });

  const body = await parseBody(c, syncSchema);
  const codes = body.people.map((p) => p.member_code);
  if (new Set(codes).size !== codes.length) throw new HTTPException(400, { message: "같은 교인ID가 두 번 들어 있습니다." });

  const db = c.env.DB;
  const system = await db
    .prepare("SELECT id, email, name, role FROM users WHERE email = 'sheet-sync@system.local'")
    .first<AppUser>();
  if (!system) throw new HTTPException(500, { message: "연동 계정이 없습니다." });

  // All synced people at once (a church-sized list), rather than IN (...): D1 caps bound values per query.
  const { results: known } = await db
    .prepare("SELECT id, member_code, name, family_code, relation FROM members WHERE member_code IS NOT NULL")
    .all<Existing>();
  const byCode = new Map(known.map((k) => [k.member_code, k]));
  const today = todayInHobart();

  const statements: D1PreparedStatement[] = [];
  let created = 0;
  let updated = 0;
  for (const p of body.people) {
    const next = { name: p.name, family_code: p.family_code ?? null, relation: p.relation || null };
    const cur = byCode.get(p.member_code);
    if (!cur) {
      created++;
      statements.push(
        db
          .prepare("INSERT INTO members (name, member_code, family_code, relation, registered_on) VALUES (?, ?, ?, ?, ?)")
          .bind(next.name, p.member_code, next.family_code, next.relation, p.registered_on ?? today),
        auditStatement(db, system, "create", "members", "last_insert", undefined, { member_code: p.member_code, ...next }),
        db
          .prepare(
            "INSERT INTO member_status_events (member_id, status_code, event_date, note, created_by) SELECT id, 'registered', ?, '목양 시트에서 등록', ? FROM members WHERE member_code = ?",
          )
          .bind(p.registered_on ?? today, system.id, p.member_code),
      );
    } else if (cur.name !== next.name || cur.family_code !== next.family_code || cur.relation !== next.relation) {
      updated++;
      statements.push(
        db.prepare("UPDATE members SET name = ?, family_code = ?, relation = ? WHERE id = ?").bind(next.name, next.family_code, next.relation, cur.id),
        auditStatement(db, system, "update", "members", cur.id, cur, { member_code: p.member_code, ...next }),
      );
    }
  }
  if (statements.length) await db.batch(statements);
  return c.json({ created, updated, unchanged: body.people.length - created - updated });
});
