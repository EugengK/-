import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import type { AppEnv } from "../types";
import { cents, isUniqueViolation, isoDate, parseBody, reason } from "../validation";

interface OpeningBalanceRow {
  id: number;
  account: "cash" | "bank";
  as_of_date: string;
  amount_cents: number;
  note: string | null;
  status: "active" | "void";
  void_reason: string | null;
  created_by: number;
  created_at: string;
}

const COLUMNS =
  "id, account, as_of_date, amount_cents, note, status, void_reason, created_by, created_at";

const createSchema = z
  .object({
    account: z.enum(["cash", "bank"]),
    as_of_date: isoDate,
    amount_cents: cents,
    note: z.string().trim().max(300).optional(),
  })
  .strict();

const voidSchema = z.object({ reason }).strict();

export const openingBalanceRoutes = new Hono<AppEnv>();

openingBalanceRoutes.get("/", async (c) => {
  const all = c.req.query("include_void") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM opening_balances ${all ? "" : "WHERE status = 'active'"} ORDER BY id`,
  ).all<OpeningBalanceRow>();
  return c.json(results);
});

openingBalanceRoutes.post("/", async (c) => {
  const body = await parseBody(c, createSchema);
  const user = c.get("user");
  const note = body.note ? body.note : null;
  try {
    // The SELECT must come before the audit INSERT, which moves last_insert_rowid() on.
    const [, created] = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO opening_balances (account, as_of_date, amount_cents, note, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(body.account, body.as_of_date, body.amount_cents, note, user.id),
      c.env.DB.prepare(`SELECT ${COLUMNS} FROM opening_balances WHERE id = last_insert_rowid()`),
      auditStatement(c.env.DB, user, "create", "opening_balances", "last_insert", undefined, {
        ...body,
        note,
      }),
    ]);
    return c.json(created!.results[0], 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HTTPException(409, {
        message: "이 계정에는 이미 시작 잔액이 있습니다. 먼저 취소 처리한 뒤 다시 입력하세요.",
      });
    }
    throw err;
  }
});

openingBalanceRoutes.post("/:id{[0-9]+}/void", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, voidSchema);
  const before = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM opening_balances WHERE id = ?`)
    .bind(id)
    .first<OpeningBalanceRow>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  if (before.status === "void") throw new HTTPException(409, { message: "이미 취소된 항목입니다." });

  const [updated] = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE opening_balances SET status = 'void', void_reason = ? WHERE id = ? AND status = 'active'",
    ).bind(body.reason, id),
    auditStatement(c.env.DB, c.get("user"), "void", "opening_balances", id, before, {
      status: "void",
      void_reason: body.reason,
    }, true, body.reason),
  ]);
  if (updated!.meta.changes === 0) {
    throw new HTTPException(409, { message: "이미 취소된 항목입니다." });
  }
  return c.json({ ...before, status: "void", void_reason: body.reason });
});
