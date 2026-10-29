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
  user_name: string | null;
  reason: string | null;
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
/**
 * The change log of the books (pastor only, see app.ts): offerings, expenses, receipt photos, fixed
 * costs, opening balances and the lists. Member-roster changes are not part of it.
 */
auditRoutes.get("/", async (c) => {
  const limit = Math.min(Math.max(Math.trunc(Number(c.req.query("limit") ?? 50)) || 50, 1), 200);
  const beforeId = Math.trunc(Number(c.req.query("before_id") ?? 0)) || 0;
  const where = [`a.table_name NOT IN (${REGISTRY_TABLES.map((t) => `'${t}'`).join(", ")})`];
  const binds: unknown[] = [];
  if (beforeId) {
    where.push("a.id < ?");
    binds.push(beforeId);
  }
  binds.push(limit);
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.at, a.user_id, a.user_email, u.name AS user_name, a.action, a.table_name, a.row_id, a.before_json, a.after_json, a.reason
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT ?`,
  )
    .bind(...binds)
    .all<AuditRow>();
  return c.json(
    results.map(({ before_json, after_json, ...rest }) => ({
      ...rest,
      before: before_json ? JSON.parse(before_json) : null,
      after: after_json ? JSON.parse(after_json) : null,
    })),
  );
});
