import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import { todayInHobart } from "../dates";
import type { AppEnv, AppUser } from "../types";
import { isRealDate, isoDate, parseBody } from "../validation";

/**
 * People from the pastor's 목양 sheet: by the sheet script (token, /api/registry/sync) or by the
 * pastor uploading a CSV of the 교인목록 tab (/api/registry/import). Only these seven fields are
 * accepted; anything else is rejected, so counselling notes can't arrive here by mistake.
 * Adds new people and updates the basic fields of known ones. Never deletes or marks anyone as
 * left: attendance is managed in the registry. A title (직분) from the sheet is used only as a
 * person's first title; after that, titles are managed in the registry.
 */
// Up to ~5 statements per new person; 100 keeps a request well under D1's per-request limit
// on the paid plan. Larger lists are sent in chunks of this size.
export const MAX_PEOPLE = 100;

const code = z.string().trim().regex(/^[A-Za-z0-9-]{3,40}$/, "ID 형식이 올바르지 않습니다.");
const text = (max: number) => z.string().transform((v) => v.normalize("NFC").trim()).pipe(z.string().max(max));
const birthDate = z
  .string()
  .refine((v) => isRealDate(v) && v >= "1900-01-01" && v <= todayInHobart(), "생년월일이 올바르지 않습니다.");

const personSchema = z
  .object({
    member_code: code,
    family_code: code.nullable().optional(),
    name: text(50).pipe(z.string().min(1)),
    relation: text(20).nullable().optional(),
    registered_on: isoDate.nullable().optional(),
    birth_date: birthDate.nullable().optional(),
    title: text(20).nullable().optional(),
  })
  .strict();

export const peopleSchema = z.object({ people: z.array(personSchema).min(1).max(MAX_PEOPLE) }).strict();
type Person = z.infer<typeof personSchema>;

/** Sheet spellings that mean one of our titles. */
const TITLE_ALIASES: Record<string, string> = { 집사: "서리집사" };

interface Existing {
  id: number;
  member_code: string;
  name: string;
  family_code: string | null;
  relation: string | null;
  birth_date: string | null;
}

export interface ApplyResult {
  created: number;
  updated: number;
  pending: number;
  unchanged: number;
  unknown_titles: string[];
}

/** Statements that give `member_code`'s person their first title (and audit it). */
export function firstTitleStatements(
  db: D1Database,
  actor: AppUser,
  memberCode: string,
  title: { id: number; name: string; term_limited: number },
  registeredOn: string,
): D1PreparedStatement[] {
  // A yearly title (서리집사) is taken as this year's appointment; others from registration.
  const year = todayInHobart().slice(0, 4);
  const start = title.term_limited ? `${year}-01-01` : registeredOn;
  const end = title.term_limited ? `${year}-12-31` : null;
  return [
    db
      .prepare(
        `INSERT INTO member_titles (member_id, title_id, start_date, end_date, note, created_by)
         SELECT id, ?, ?, ?, '시트의 직분으로 처음 등록', ? FROM members WHERE member_code = ?`,
      )
      .bind(title.id, start, end, actor.id, memberCode),
    auditStatement(db, actor, "create", "member_titles", "last_insert", undefined, {
      member_code: memberCode, title_name: title.name, start_date: start, end_date: end,
    }),
  ];
}

export async function loadTitles(db: D1Database) {
  const { results } = await db
    .prepare("SELECT id, name, term_limited FROM titles WHERE is_active = 1")
    .all<{ id: number; name: string; term_limited: number }>();
  const byName = new Map(results.map((t) => [t.name, t]));
  return (raw: string | null | undefined) => {
    if (!raw) return { title: null, unknown: null };
    const t = byName.get(TITLE_ALIASES[raw] ?? raw);
    return t ? { title: t, unknown: null } : { title: null, unknown: raw };
  };
}

export async function applyPeople(db: D1Database, actor: AppUser, people: Person[]): Promise<ApplyResult> {
  const codes = people.map((p) => p.member_code);
  if (new Set(codes).size !== codes.length) throw new HTTPException(400, { message: "같은 교인ID가 두 번 들어 있습니다." });

  // Whole tables (church-sized) rather than IN (...): D1 caps bound values per query.
  const [known, unlinked, titled] = await db.batch([
    db.prepare("SELECT id, member_code, name, family_code, relation, birth_date FROM members WHERE member_code IS NOT NULL"),
    db.prepare("SELECT name FROM members WHERE member_code IS NULL"),
    db.prepare("SELECT DISTINCT member_id FROM member_titles"),
  ]);
  const byCode = new Map((known!.results as unknown as Existing[]).map((k) => [k.member_code, k]));
  const unlinkedNames = new Set((unlinked!.results as { name: string }[]).map((u) => u.name));
  const hasTitle = new Set((titled!.results as { member_id: number }[]).map((t) => t.member_id));
  const resolveTitle = await loadTitles(db);
  const today = todayInHobart();

  const statements: D1PreparedStatement[] = [];
  const result: ApplyResult = { created: 0, updated: 0, pending: 0, unchanged: 0, unknown_titles: [] };
  for (const p of people) {
    const next = {
      name: p.name,
      family_code: p.family_code ?? null,
      relation: p.relation || null,
      birth_date: p.birth_date ?? null,
    };
    const { title, unknown } = resolveTitle(p.title);
    if (unknown && !result.unknown_titles.includes(unknown)) result.unknown_titles.push(unknown);
    const cur = byCode.get(p.member_code);
    const registeredOn = p.registered_on ?? today;

    if (!cur && unlinkedNames.has(next.name)) {
      // Someone with this name was entered by hand: don't guess, let the pastor link or create.
      result.pending++;
      statements.push(
        db
          .prepare(
            `INSERT INTO sync_pending (member_code, family_code, name, relation, registered_on, birth_date, title)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (member_code) DO UPDATE SET family_code = excluded.family_code, name = excluded.name,
               relation = excluded.relation, registered_on = excluded.registered_on,
               birth_date = excluded.birth_date, title = excluded.title`,
          )
          .bind(p.member_code, next.family_code, next.name, next.relation, p.registered_on ?? null, next.birth_date, title?.name ?? null),
      );
    } else if (!cur) {
      result.created++;
      statements.push(
        db
          .prepare("INSERT INTO members (name, member_code, family_code, relation, birth_date, registered_on) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(next.name, p.member_code, next.family_code, next.relation, next.birth_date, registeredOn),
        auditStatement(db, actor, "create", "members", "last_insert", undefined, { member_code: p.member_code, ...next }),
        db
          .prepare(
            "INSERT INTO member_status_events (member_id, status_code, event_date, note, created_by) SELECT id, 'registered', ?, '목양 시트에서 등록', ? FROM members WHERE member_code = ?",
          )
          .bind(registeredOn, actor.id, p.member_code),
        ...(title ? firstTitleStatements(db, actor, p.member_code, title, registeredOn) : []),
      );
    } else {
      const changed =
        cur.name !== next.name || cur.family_code !== next.family_code || cur.relation !== next.relation ||
        (next.birth_date !== null && cur.birth_date !== next.birth_date);
      const addTitle = title && !hasTitle.has(cur.id);
      if (changed) {
        const birth = next.birth_date ?? cur.birth_date; // a blank cell never erases a known birth date
        statements.push(
          db
            .prepare("UPDATE members SET name = ?, family_code = ?, relation = ?, birth_date = ? WHERE id = ?")
            .bind(next.name, next.family_code, next.relation, birth, cur.id),
          auditStatement(db, actor, "update", "members", cur.id, cur, { member_code: p.member_code, ...next, birth_date: birth }),
        );
      }
      if (addTitle) statements.push(...firstTitleStatements(db, actor, p.member_code, title, registeredOn));
      if (changed || addTitle) result.updated++;
      else result.unchanged++;
    }
  }
  if (statements.length) await db.batch(statements);
  return result;
}

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

/** The sheet script's entry point (token auth, mounted before user login). */
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

  const body = await parseBody(c, peopleSchema);
  const system = await c.env.DB
    .prepare("SELECT id, email, name, role FROM users WHERE email = 'sheet-sync@system.local'")
    .first<Omit<AppUser, "registry_admin">>();
  if (!system) throw new HTTPException(500, { message: "연동 계정이 없습니다." });
  return c.json(await applyPeople(c.env.DB, { ...system, registry_admin: false }, body.people));
});
