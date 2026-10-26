import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditStatement } from "../audit";
import type { AppEnv } from "../types";
import { isRealDate, isoDate, optionalText, parseBody, reason } from "../validation";

interface OfferingRow {
  id: number;
  offering_date: string;
  fund_type_id: number;
  fund_type_name: string;
  amount_cents: number;
  method: "cash" | "online";
  member_id: number | null;
  member_name: string | null;
  note: string | null;
  status: "active" | "void";
  void_reason: string | null;
  created_by: number;
  created_at: string;
}

const SELECT = `SELECT o.id, o.offering_date, o.fund_type_id, f.name AS fund_type_name, o.amount_cents, o.method,
  o.member_id, m.name AS member_name, o.note, o.status, o.void_reason, o.created_by, o.created_at
  FROM offerings o JOIN fund_types f ON f.id = o.fund_type_id LEFT JOIN members m ON m.id = o.member_id`;

// 3 statements per line; keeps one request well under D1's per-request query limit on the paid plan.
const MAX_ENTRIES = 50;

const entrySchema = z
  .object({
    fund_type_id: z.number().int().positive(),
    // $10,000,000 per line is far above anything real; it only guards against typos like extra zeros.
    amount_cents: z.number().int("센트 단위 정수여야 합니다.").positive("금액은 0보다 커야 합니다.").max(1_000_000_000),
    method: z.enum(["cash", "online"]),
    member_id: z.number().int().positive().nullable().optional(),
    note: optionalText(300),
  })
  .strict();

const createSchema = z
  .object({
    offering_date: isoDate,
    entries: z.array(entrySchema).min(1, "헌금 내역을 1건 이상 입력하세요.").max(MAX_ENTRIES),
  })
  .strict();

const voidSchema = z.object({ reason }).strict();

/** Shared filter parsing for list and summary. */
function filters(q: (k: string) => string | undefined) {
  const where: string[] = [];
  const binds: unknown[] = [];
  const from = q("from");
  const to = q("to");
  for (const [key, value, op] of [
    ["from", from, ">="],
    ["to", to, "<="],
  ] as const) {
    if (value === undefined || value === "") continue;
    if (!isRealDate(value)) throw new HTTPException(400, { message: `${key}: YYYY-MM-DD 형식이어야 합니다.` });
    where.push(`o.offering_date ${op} ?`);
    binds.push(value);
  }
  for (const key of ["fund_type_id", "member_id"] as const) {
    const value = q(key);
    if (value === undefined || value === "") continue;
    if (!/^[0-9]{1,15}$/.test(value)) throw new HTTPException(400, { message: `${key}: 숫자여야 합니다.` });
    where.push(`o.${key} = ?`);
    binds.push(Number(value));
  }
  const method = q("method");
  if (method !== undefined && method !== "") {
    if (method !== "cash" && method !== "online") throw new HTTPException(400, { message: "method: cash 또는 online" });
    where.push("o.method = ?");
    binds.push(method);
  }
  return { where, binds };
}

export const offeringRoutes = new Hono<AppEnv>();

offeringRoutes.get("/", async (c) => {
  const { where, binds } = filters((k) => c.req.query(k));
  if (c.req.query("include_void") !== "1") where.push("o.status = 'active'");
  const { results } = await c.env.DB.prepare(
    `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY o.offering_date DESC, o.id DESC LIMIT 1000`,
  )
    .bind(...binds)
    .all<OfferingRow>();
  return c.json(results);
});

/** Totals per offering type and method (active rows only). Works for one member too (member_id=). */
offeringRoutes.get("/summary", async (c) => {
  const { where, binds } = filters((k) => c.req.query(k));
  where.push("o.status = 'active'");
  const { results } = await c.env.DB.prepare(
    `SELECT o.fund_type_id, f.name AS fund_type_name, o.method,
            SUM(o.amount_cents) AS total_cents, COUNT(*) AS count
     FROM offerings o JOIN fund_types f ON f.id = o.fund_type_id
     WHERE ${where.join(" AND ")}
     GROUP BY o.fund_type_id, o.method ORDER BY f.sort_order, f.id, o.method`,
  )
    .bind(...binds)
    .all<{ fund_type_id: number; fund_type_name: string; method: string; total_cents: number; count: number }>();
  const total = results.reduce((s, r) => s + r.total_cents, 0);
  const byMethod = { cash: 0, online: 0 } as Record<string, number>;
  for (const r of results) byMethod[r.method] = (byMethod[r.method] ?? 0) + r.total_cents;
  return c.json({ rows: results, total_cents: total, cash_cents: byMethod.cash, online_cents: byMethod.online });
});

/** Records one service's offerings in a single all-or-nothing write. */
offeringRoutes.post("/", async (c) => {
  const body = await parseBody(c, createSchema);
  const db = c.env.DB;
  const user = c.get("user");

  const fundIds = [...new Set(body.entries.map((e) => e.fund_type_id))];
  const memberIds = [...new Set(body.entries.map((e) => e.member_id).filter((v): v is number => v != null))];
  const activeFunds = await db
    .prepare(`SELECT id FROM fund_types WHERE is_active = 1 AND id IN (${fundIds.map(() => "?").join(",")})`)
    .bind(...fundIds)
    .all<{ id: number }>();
  if (activeFunds.results.length !== fundIds.length) {
    throw new HTTPException(400, { message: "없거나 사용 중지된 헌금 종류가 있습니다." });
  }
  if (memberIds.length) {
    const activeMembers = await db
      .prepare(`SELECT id FROM members WHERE is_active = 1 AND id IN (${memberIds.map(() => "?").join(",")})`)
      .bind(...memberIds)
      .all<{ id: number }>();
    if (activeMembers.results.length !== memberIds.length) {
      throw new HTTPException(400, { message: "없거나 비활성화된 성도가 있습니다." });
    }
  }

  const statements: D1PreparedStatement[] = [];
  for (const e of body.entries) {
    const row = {
      offering_date: body.offering_date,
      fund_type_id: e.fund_type_id,
      amount_cents: e.amount_cents,
      method: e.method,
      member_id: e.member_id ?? null,
      note: e.note ?? null,
    };
    statements.push(
      db
        .prepare(
          `INSERT INTO offerings (offering_date, fund_type_id, amount_cents, method, member_id, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(row.offering_date, row.fund_type_id, row.amount_cents, row.method, row.member_id, row.note, user.id),
      // Before the audit INSERT, which moves last_insert_rowid() on.
      db.prepare(`${SELECT} WHERE o.id = last_insert_rowid()`),
      auditStatement(db, user, "create", "offerings", "last_insert", undefined, row),
    );
  }
  const results = await db.batch(statements);
  const created = results.filter((_, i) => i % 3 === 1).map((r) => r.results[0] as OfferingRow);
  return c.json(created, 201);
});

offeringRoutes.post("/:id{[0-9]+}/void", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, voidSchema);
  const before = await c.env.DB.prepare(`${SELECT} WHERE o.id = ?`).bind(id).first<OfferingRow>();
  if (!before) throw new HTTPException(404, { message: "찾을 수 없습니다." });
  if (before.status === "void") throw new HTTPException(409, { message: "이미 취소된 항목입니다." });

  const [updated] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE offerings SET status = 'void', void_reason = ? WHERE id = ? AND status = 'active'").bind(
      body.reason,
      id,
    ),
    auditStatement(
      c.env.DB,
      c.get("user"),
      "void",
      "offerings",
      id,
      before,
      { status: "void", void_reason: body.reason },
      true,
    ),
  ]);
  if (updated!.meta.changes === 0) throw new HTTPException(409, { message: "이미 취소된 항목입니다." });
  return c.json({ ...before, status: "void", void_reason: body.reason });
});
