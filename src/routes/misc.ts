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

export const auditRoutes = new Hono<AppEnv>();
auditRoutes.get("/", async (c) => {
  const limit = Math.min(Math.max(Math.trunc(Number(c.req.query("limit") ?? 50)) || 50, 1), 200);
  const beforeId = Math.trunc(Number(c.req.query("before_id") ?? 0)) || 0;
  const { results } = await c.env.DB.prepare(
    `SELECT id, at, user_id, user_email, action, table_name, row_id, before_json, after_json
     FROM audit_log ${beforeId ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`,
  )
    .bind(...(beforeId ? [beforeId, limit] : [limit]))
    .all<AuditRow>();
  return c.json(
    results.map(({ before_json, after_json, ...rest }) => ({
      ...rest,
      before: before_json ? JSON.parse(before_json) : null,
      after: after_json ? JSON.parse(after_json) : null,
    })),
  );
});
