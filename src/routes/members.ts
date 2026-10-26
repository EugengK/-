import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import { todayInHobart } from "../dates";
import { CURRENT_STATUS, CURRENT_TITLE } from "../registrySql";
import type { AppEnv } from "../types";
import { name, optionalText, parseBody } from "../validation";

interface MemberRow {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  note: string | null;
  relation: string | null;
  is_active: number;
}

const COLUMNS = "id, name, phone, email, note, relation, is_active";

const fields = {
  phone: optionalText(30),
  email: optionalText(100),
  note: optionalText(300),
  relation: optionalText(20),
};

const createSchema = z.object({ name, ...fields }).strict();

/**
 * `expected` = the values the editor's screen showed. If the stored row no longer matches
 * (someone else changed it since), the update is refused instead of overwriting their change.
 * Whether someone is still attending is not edited here: it follows the status history.
 */
const updateSchema = z
  .object({
    name: name.optional(),
    ...fields,
    expected: z
      .object({
        name: z.string(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
        note: z.string().nullable(),
        relation: z.string().nullable(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "expected"), "바꿀 내용을 입력하세요.");

// Names are not unique on purpose: two members can share a name.
export const memberRoutes = new Hono<AppEnv>();

memberRoutes.get("/", async (c) => {
  const all = c.req.query("include_inactive") === "1";
  const q = (c.req.query("q") ?? "").normalize("NFC").trim();
  const where: string[] = [];
  const binds: unknown[] = [todayInHobart()]; // ?1
  if (!all) where.push("m.is_active = 1");
  if (q) {
    // instr() instead of LIKE so % and _ in the search text are taken literally.
    binds.push(q);
    where.push(`instr(lower(m.name), lower(?${binds.length})) > 0`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.name, m.phone, m.email, m.note, m.relation, m.is_active, m.member_code, m.family_code,
            m.registered_on, ${CURRENT_TITLE} AS current_title, ${CURRENT_STATUS} AS current_status
     FROM members m ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.name, m.id`,
  )
    .bind(...binds)
    .all<Record<string, unknown>>();
  return c.json(results.map((r) => ({ ...r, is_active: r.is_active === 1 })));
});

/** Manual entry for someone not in the pastor's sheet (e.g. a regular visitor who gives). */
memberRoutes.post("/", async (c) => {
  const body = await parseBody(c, createSchema);
  const user = c.get("user");
  const row = {
    name: body.name,
    phone: body.phone ?? null,
    email: body.email ?? null,
    note: body.note ?? null,
    relation: body.relation ?? null,
  };
  const today = todayInHobart();
  const db = c.env.DB;
  // The SELECT must come before the audit INSERT, which moves last_insert_rowid() on.
  const [, created] = await db.batch([
    db
      .prepare("INSERT INTO members (name, phone, email, note, relation, registered_on) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(row.name, row.phone, row.email, row.note, row.relation, today),
    db.prepare(`SELECT ${COLUMNS} FROM members WHERE id = last_insert_rowid()`),
    auditStatement(db, user, "create", "members", "last_insert", undefined, row),
    db
      .prepare(
        "INSERT INTO member_status_events (member_id, status_code, event_date, note, created_by) SELECT MAX(id), 'registered', ?, '직접 등록', ? FROM members",
      )
      .bind(today, user.id),
  ]);
  const m = created!.results[0] as MemberRow;
  return c.json({ ...m, is_active: m.is_active === 1 }, 201);
});

memberRoutes.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, updateSchema);
  const before = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM members WHERE id = ?`).bind(id).first<MemberRow>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  const STALE = "다른 사람이 먼저 수정했습니다. 새로고침 후 다시 시도하세요.";
  for (const [k, v] of Object.entries(body.expected ?? {})) {
    if (before[k as keyof MemberRow] !== v) throw new HTTPException(409, { message: STALE });
  }

  const pick = <K extends "phone" | "email" | "note" | "relation">(k: K) => (body[k] === undefined ? before[k] : body[k]);
  const next = {
    name: body.name ?? before.name,
    phone: pick("phone"),
    email: pick("email"),
    note: pick("note"),
    relation: pick("relation"),
  };
  // Guarded on the values read above, so an edit landing in between is not overwritten either.
  const [updated] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE members SET name = ?, phone = ?, email = ?, note = ?, relation = ?
       WHERE id = ? AND name IS ? AND phone IS ? AND email IS ? AND note IS ? AND relation IS ?`,
    ).bind(
      next.name, next.phone, next.email, next.note, next.relation,
      id, before.name, before.phone, before.email, before.note, before.relation,
    ),
    auditStatement(c.env.DB, c.get("user"), "update", "members", id, before, { id, ...next }, true),
  ]);
  if (updated!.meta.changes === 0) throw new HTTPException(409, { message: STALE });
  return c.json({ ...before, ...next, is_active: before.is_active === 1 });
});

