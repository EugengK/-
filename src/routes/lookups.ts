import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import type { AppEnv } from "../types";
import { isUniqueViolation, name, parseBody } from "../validation";

interface LookupRow {
  id: number;
  name: string;
  sort_order: number;
  is_active: number;
}

const createSchema = z
  .object({ name, sort_order: z.number().int().min(0).max(9999).optional() })
  .strict();

const updateSchema = z
  .object({
    name: name.optional(),
    sort_order: z.number().int().min(0).max(9999).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "바꿀 내용을 입력하세요.");

/**
 * CRUD-lite for simple named lists (offering types, departments, expense categories).
 * `table` is always a hard-coded constant from this codebase, never request input.
 */
export function lookupRoutes(table: "fund_types" | "departments" | "expense_categories") {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const all = c.req.query("include_inactive") === "1";
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, sort_order, is_active FROM ${table}
       ${all ? "" : "WHERE is_active = 1"} ORDER BY sort_order, id`,
    ).all<LookupRow>();
    return c.json(results.map((r) => ({ ...r, is_active: r.is_active === 1 })));
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, createSchema);
    const sortOrder = body.sort_order ?? 0;
    try {
      // The SELECT must come before the audit INSERT, which moves last_insert_rowid() on.
      const [, created] = await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO ${table} (name, sort_order) VALUES (?, ?)`).bind(body.name, sortOrder),
        c.env.DB.prepare(`SELECT id, name, sort_order, is_active FROM ${table} WHERE id = last_insert_rowid()`),
        auditStatement(c.env.DB, c.get("user"), "create", table, "last_insert", undefined, {
          name: body.name,
          sort_order: sortOrder,
        }),
      ]);
      const row = created!.results[0] as LookupRow;
      return c.json({ ...row, is_active: row.is_active === 1 }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HTTPException(409, { message: "이미 있는 이름입니다." });
      throw err;
    }
  });

  app.patch("/:id{[0-9]+}", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await parseBody(c, updateSchema);
    const before = await c.env.DB.prepare(`SELECT id, name, sort_order, is_active FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<LookupRow>();
    if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });

    const next = {
      name: body.name ?? before.name,
      sort_order: body.sort_order ?? before.sort_order,
      is_active: body.is_active === undefined ? before.is_active : body.is_active ? 1 : 0,
    };
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE ${table} SET name = ?, sort_order = ?, is_active = ? WHERE id = ?`).bind(
          next.name,
          next.sort_order,
          next.is_active,
          id,
        ),
        auditStatement(c.env.DB, c.get("user"), "update", table, id, before, { id, ...next }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HTTPException(409, { message: "이미 있는 이름입니다." });
      throw err;
    }
    return c.json({ id, name: next.name, sort_order: next.sort_order, is_active: next.is_active === 1 });
  });

  return app;
}
