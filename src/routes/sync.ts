import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import { todayInHobart } from "../dates";
import type { AppEnv, AppUser } from "../types";
import { isRealDate, nameKey, parseBody, pastDate } from "../validation";

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
    // Not in the future: the 'registered' event would otherwise outrank every later status change.
    registered_on: pastDate(todayInHobart).nullable().optional(),
    birth_date: birthDate.nullable().optional(),
    title: text(20).nullable().optional(),
  })
  .strict();

export const peopleSchema = z.object({ people: z.array(personSchema).min(1).max(MAX_PEOPLE) }).strict();
type Person = z.infer<typeof personSchema>;

/** Sheet spellings that mean one of our titles. */
const TITLE_ALIASES: Record<string, string> = { 집사: "서리집사", 시무장로: "장로", 시무권사: "권사", 안수집사: "장립집사" };

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
  const [known, unlinked, titled, pendingRows] = await db.batch([
    db.prepare("SELECT id, member_code, name, family_code, relation, birth_date FROM members WHERE member_code IS NOT NULL"),
    db.prepare("SELECT id, name, birth_date, relation FROM members WHERE member_code IS NULL"),
    db.prepare("SELECT DISTINCT member_id FROM member_titles"),
    db.prepare("SELECT member_code FROM sync_pending"),
  ]);
  const pendingCodes = new Set((pendingRows!.results as { member_code: string }[]).map((r) => r.member_code));
  /** A row resolved some other way no longer needs the pastor's decision. */
  const clearPending = (code: string) =>
    pendingCodes.has(code) ? [db.prepare("DELETE FROM sync_pending WHERE member_code = ?").bind(code)] : [];
  const byCode = new Map((known!.results as unknown as Existing[]).map((k) => [k.member_code, k]));
  const unlinkedRows = unlinked!.results as { id: number; name: string; birth_date: string | null; relation: string | null }[];
  const unlinkedNames = new Set(unlinkedRows.map((u) => nameKey(u.name)));
  /** A hand-entered/roster person who is certainly this sheet row: same name AND same birth date, only one. */
  const sureMatch = (name: string, birth: string | null) => {
    if (!birth) return null;
    const hits = unlinkedRows.filter((u) => nameKey(u.name) === nameKey(name) && u.birth_date === birth);
    return hits.length === 1 ? hits[0]! : null;
  };
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

    const sure = !cur ? sureMatch(next.name, next.birth_date) : null;
    if (sure) {
      // Same name and birth date: link the existing record to the sheet's 교인ID (keeps its history).
      result.updated++;
      unlinkedRows.splice(unlinkedRows.indexOf(sure), 1);
      const after = { member_code: p.member_code, family_code: next.family_code, relation: next.relation ?? sure.relation };
      statements.push(
        db
          .prepare("UPDATE members SET member_code = ?, family_code = ?, relation = ? WHERE id = ? AND member_code IS NULL")
          .bind(after.member_code, after.family_code, after.relation, sure.id),
        auditStatement(db, actor, "update", "members", sure.id, sure, after),
        ...clearPending(p.member_code),
      );
      unlinkedNames.clear();
      for (const u of unlinkedRows) unlinkedNames.add(nameKey(u.name));
      if (title && !hasTitle.has(sure.id)) statements.push(...firstTitleStatements(db, actor, p.member_code, title, registeredOn));
    } else if (!cur && unlinkedNames.has(nameKey(next.name))) {
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
        ...clearPending(p.member_code),
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
      statements.push(...clearPending(p.member_code));
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

// ---------- 교인명부 (roster) ----------

/**
 * The church roster (직분/학년, 성명, 생년월일, 연락처 …, newer ones also 교인ID/가정ID).
 * With a 교인ID, that ID decides who is who; a 교인ID used twice in one file is skipped. Without
 * one, people are matched by name + birth date, and a same-name person with no birth date on either
 * side is matched only when there is exactly one. Never deletes or changes attendance.
 */
const rosterPersonSchema = z
  .object({
    // Newer rosters carry the sheet's IDs; they then decide who is who (and the family).
    member_code: code.nullable().optional(),
    family_code: code.nullable().optional(),
    name: text(50).pipe(z.string().min(1)),
    birth_date: birthDate.nullable().optional(),
    phone: text(30).nullable().optional(),
    title: text(20).nullable().optional(),
    note: text(100).nullable().optional(),
  })
  .strict();
export const rosterSchema = z.object({ people: z.array(rosterPersonSchema).min(1).max(MAX_PEOPLE) }).strict();
type RosterPerson = z.infer<typeof rosterPersonSchema>;

export interface RosterResult {
  created: number;
  updated: number;
  unchanged: number;
  ambiguous: string[];
  unknown_titles: string[];
}

export async function applyRoster(db: D1Database, actor: AppUser, people: RosterPerson[]): Promise<RosterResult> {
  const [all, titled] = await db.batch([
    db.prepare("SELECT id, name, birth_date, phone, member_code, family_code FROM members"),
    db.prepare("SELECT DISTINCT member_id FROM member_titles"),
  ]);
  const members = all!.results as {
    id: number; name: string; birth_date: string | null; phone: string | null; member_code: string | null; family_code: string | null;
  }[];
  const hasTitle = new Set((titled!.results as { member_id: number }[]).map((t) => t.member_id));
  const resolveTitle = await loadTitles(db);
  const today = todayInHobart();
  const result: RosterResult = { created: 0, updated: 0, unchanged: 0, ambiguous: [], unknown_titles: [] };
  const statements: D1PreparedStatement[] = [];
  const touched = new Set<number>(); // matched earlier in this file
  const codesInFile = new Map<string, number>();
  for (const p of people) if (p.member_code) codesInFile.set(p.member_code, (codesInFile.get(p.member_code) ?? 0) + 1);

  for (const p of people) {
    if (p.name === "-") continue;
    const birth = p.birth_date ?? null;
    const phone = p.phone || null;
    const memberCode = p.member_code ?? null;
    const familyCode = p.family_code ?? null;
    const { title, unknown } = resolveTitle(p.title);
    if (unknown && !result.unknown_titles.includes(unknown)) result.unknown_titles.push(unknown);

    // Matching is deliberately conservative: merging two different people would attach one
    // person's giving to another. When in doubt the row is skipped and reported.
    const key = nameKey(p.name);
    // People already holding another 교인ID are someone else, whatever their name.
    const sameName = members.filter((m) => nameKey(m.name) === key && (!memberCode || !m.member_code || m.member_code === memberCode));
    let match: (typeof members)[number] | null = null;
    let why = "";
    const byCode = memberCode ? members.find((m) => m.member_code === memberCode) : undefined;
    if (memberCode && (codesInFile.get(memberCode) ?? 0) > 1) {
      why = `교인ID ${memberCode}가 파일에 두 번 이상`;
    } else if (byCode) {
      if (nameKey(byCode.name) === key) match = byCode;
      else why = `교인ID ${memberCode}는 이미 '${byCode.name}'(으)로 등록됨`;
    } else if (birth) {
      const exact = sameName.filter((m) => m.birth_date === birth);
      if (exact.length === 1) match = exact[0]!;
      else if (exact.length > 1) why = "같은 이름·생년월일이 여럿";
      else if (sameName.some((m) => m.birth_date === null)) why = "생년월일이 없는 같은 이름이 있음";
      // else: same name with a different birth date -> a different person (created below)
    } else if (phone) {
      const samePhone = sameName.filter((m) => m.phone === phone);
      if (samePhone.length === 1) match = samePhone[0]!;
      else if (sameName.length) why = "생년월일이 없어 같은 분인지 알 수 없음";
    } else if (sameName.length) why = "생년월일·연락처가 없어 같은 분인지 알 수 없음";
    if (match && (match.id === -1 || touched.has(match.id))) {
      match = null;
      why = "파일 안에 같은 분이 두 번";
    }
    if (why) {
      result.ambiguous.push(`${p.name}(${why})`);
      continue;
    }
    if (match) {
      touched.add(match.id);
      // Only fills gaps: an existing phone, birth date or ID is never overwritten by the roster.
      const next = {
        birth_date: match.birth_date ?? birth,
        phone: match.phone ?? phone,
        member_code: match.member_code ?? memberCode,
        family_code: match.family_code ?? familyCode,
      };
      const changed = next.birth_date !== match.birth_date || next.phone !== match.phone
        || next.member_code !== match.member_code || next.family_code !== match.family_code;
      const addTitle = title && !hasTitle.has(match.id);
      if (changed) {
        statements.push(
          db.prepare("UPDATE members SET birth_date = ?, phone = ?, member_code = ?, family_code = ? WHERE id = ?")
            .bind(next.birth_date, next.phone, next.member_code, next.family_code, match.id),
          auditStatement(db, actor, "update", "members", match.id, match, next),
        );
        Object.assign(match, next);
      }
      if (addTitle) {
        const year = today.slice(0, 4);
        statements.push(
          db
            .prepare("INSERT INTO member_titles (member_id, title_id, start_date, end_date, note, created_by) VALUES (?, ?, ?, ?, '교인명부의 직분으로 처음 등록', ?)")
            .bind(match.id, title.id, title.term_limited ? `${year}-01-01` : today, title.term_limited ? `${year}-12-31` : null, actor.id),
          auditStatement(db, actor, "create", "member_titles", "last_insert", undefined, { member_id: match.id, title_name: title.name }),
        );
        hasTitle.add(match.id);
      }
      if (changed || addTitle) result.updated++;
      else result.unchanged++;
      continue;
    }

    result.created++;
    const row = { name: p.name, birth_date: birth, phone, note: p.note || null, member_code: memberCode, family_code: familyCode };
    members.push({ id: -1, name: p.name, birth_date: birth, phone, member_code: memberCode, family_code: familyCode }); // later rows see it
    const year = today.slice(0, 4);
    statements.push(
      db.prepare("INSERT INTO members (name, birth_date, phone, note, registered_on, member_code, family_code) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(row.name, row.birth_date, row.phone, row.note, today, row.member_code, row.family_code),
      auditStatement(db, actor, "create", "members", "last_insert", undefined, row),
      db
        .prepare("INSERT INTO member_status_events (member_id, status_code, event_date, note, created_by) SELECT MAX(id), 'registered', ?, '교인명부에서 등록', ? FROM members")
        .bind(today, actor.id),
      ...(title
        ? [
            db
              .prepare("INSERT INTO member_titles (member_id, title_id, start_date, end_date, note, created_by) SELECT MAX(id), ?, ?, ?, '교인명부의 직분으로 처음 등록', ? FROM members")
              .bind(title.id, title.term_limited ? `${year}-01-01` : today, title.term_limited ? `${year}-12-31` : null, actor.id),
            auditStatement(db, actor, "create", "member_titles", "last_insert", undefined, { member_name: p.name, title_name: title.name }),
          ]
        : []),
    );
  }
  if (statements.length) await db.batch(statements);
  return result;
}
