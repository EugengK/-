import { Hono } from "hono";
import type { AppEnv } from "../types";

interface AuditRow {
  id: number;
  at: string;
  user_id: number;
  user_email: string;
  action: string;
  table_name: string;
  row_id: number | null;
  before_json: string | null;
  after_json: string | null;
}

export const meRoutes = new Hono<AppEnv>();
meRoutes.get("/", (c) => c.json(c.get("user")));

export const userRoutes = new Hono<AppEnv>();
userRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, email, name, role, registry_admin, is_active FROM users WHERE email NOT LIKE '%@system.local' ORDER BY id",
  ).all<{ id: number; email: string; name: string; role: string; registry_admin: number; is_active: number }>();
  return c.json(results.map((u) => ({ ...u, registry_admin: u.registry_admin === 1, is_active: u.is_active === 1 })));
});

export const settingsRoutes = new Hono<AppEnv>();
settingsRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings ORDER BY key").all<{
    key: string;
    value: string;
  }>();
  return c.json(Object.fromEntries(results.map((r) => [r.key, r.value])));
});

const REGISTRY_TABLES = ["members", "member_titles", "member_status_events", "titles", "sync_pending"];

export const auditRoutes = new Hono<AppEnv>();
auditRoutes.get("/", async (c) => {
  const limit = Math.min(Math.max(Math.trunc(Number(c.req.query("limit") ?? 50)) || 50, 1), 200);
  const beforeId = Math.trunc(Number(c.req.query("before_id") ?? 0)) || 0;
  const where: string[] = [];
  const binds: unknown[] = [];
  // Registry changes carry birth dates, families and notes: only the 교적부 manager sees them.
  if (!c.get("user").registry_admin) where.push(`table_name NOT IN (${REGISTRY_TABLES.map((t) => `'${t}'`).join(", ")})`);
  if (beforeId) {
    where.push("id < ?");
    binds.push(beforeId);
  }
  binds.push(limit);
  const { results } = await c.env.DB.prepare(
    `SELECT id, at, user_id, user_email, action, table_name, row_id, before_json, after_json
     FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
  )
    .bind(...binds)
    .all<AuditRow>();
  // Offering entries name the giver (member_id, visitor_name): the pastor's alone, like the list.
  const pastor = c.get("user").registry_admin;
  const open = (json: string | null, table: string) => {
    if (!json) return null;
    const v = JSON.parse(json);
    if (!pastor && table === "offerings" && v && typeof v === "object") {
      delete v.member_id;
      delete v.visitor_name;
      delete v.member_name;
    }
    return v;
  };
  return c.json(
    results.map(({ before_json, after_json, ...rest }) => ({
      ...rest,
      before: open(before_json, rest.table_name),
      after: open(after_json, rest.table_name),
    })),
  );
});
