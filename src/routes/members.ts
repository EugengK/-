import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import type { AppEnv } from "../types";
import { name, optionalText, parseBody } from "../validation";

interface MemberRow {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  note: string | null;
  is_active: number;
}

const COLUMNS = "id, name, phone, email, note, is_active";

const fields = {
  phone: optionalText(30),
  email: optionalText(100),
  note: optionalText(300),
};

const createSchema = z.object({ name, ...fields }).strict();

/**
 * `expected` = the values the editor's screen showed. If the stored row no longer matches
 * (someone else changed it since), the update is refused instead of overwriting their change.
 */
const updateSchema = z
  .object({
    name: name.optional(),
    ...fields,
    is_active: z.boolean().optional(),
    expected: z
      .object({
        name: z.string(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
        note: z.string().nullable(),
        is_active: z.boolean(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "expected"), "바꿀 내용을 입력하세요.");

const out = (r: MemberRow) => ({ ...r, is_active: r.is_active === 1 });

// Names are not unique on purpose: two members can share a name. Use `note` to tell them apart.
export const memberRoutes = new Hono<AppEnv>();

memberRoutes.get("/", async (c) => {
  const all = c.req.query("include_inactive") === "1";
  const q = (c.req.query("q") ?? "").normalize("NFC").trim();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!all) where.push("is_active = 1");
  if (q) {
    // instr() instead of LIKE so % and _ in the search text are taken literally.
    where.push("instr(lower(name), lower(?)) > 0");
    binds.push(q);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM members ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY name, id`,
  )
    .bind(...binds)
    .all<MemberRow>();
  return c.json(results.map(out));
});

memberRoutes.post("/", async (c) => {
  const body = await parseBody(c, createSchema);
  const row = { name: body.name, phone: body.phone ?? null, email: body.email ?? null, note: body.note ?? null };
  // The SELECT must come before the audit INSERT, which moves last_insert_rowid() on.
  const [, created] = await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO members (name, phone, email, note) VALUES (?, ?, ?, ?)").bind(
      row.name,
      row.phone,
      row.email,
      row.note,
    ),
    c.env.DB.prepare(`SELECT ${COLUMNS} FROM members WHERE id = last_insert_rowid()`),
    auditStatement(c.env.DB, c.get("user"), "create", "members", "last_insert", undefined, row),
  ]);
  return c.json(out(created!.results[0] as MemberRow), 201);
});

memberRoutes.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, updateSchema);
  const before = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM members WHERE id = ?`).bind(id).first<MemberRow>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  const STALE = "다른 사람이 먼저 수정했습니다. 새로고침 후 다시 시도하세요.";
  for (const [k, v] of Object.entries(body.expected ?? {})) {
    const current = k === "is_active" ? before.is_active === 1 : before[k as keyof MemberRow];
    if (current !== v) throw new HTTPException(409, { message: STALE });
  }

  const next = {
    name: body.name ?? before.name,
    phone: body.phone === undefined ? before.phone : body.phone,
    email: body.email === undefined ? before.email : body.email,
    note: body.note === undefined ? before.note : body.note,
    is_active: body.is_active === undefined ? before.is_active : body.is_active ? 1 : 0,
  };
  // Guarded on the values read above, so an edit landing in between is not overwritten either.
  const [updated] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE members SET name = ?, phone = ?, email = ?, note = ?, is_active = ?
       WHERE id = ? AND name IS ? AND phone IS ? AND email IS ? AND note IS ? AND is_active IS ?`,
    ).bind(
      next.name,
      next.phone,
      next.email,
      next.note,
      next.is_active,
      id,
      before.name,
      before.phone,
      before.email,
      before.note,
      before.is_active,
    ),
    auditStatement(c.env.DB, c.get("user"), "update", "members", id, before, { id, ...next }, true),
  ]);
  if (updated!.meta.changes === 0) throw new HTTPException(409, { message: STALE });
  return c.json(out({ id, ...next }));
});
