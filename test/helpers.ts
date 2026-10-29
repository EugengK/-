import { env } from "cloudflare:workers";
import { createApp } from "../src/app";
import type { Env, TokenVerifier } from "../src/types";

export const db = env.DB;

/** Stand-in for Cloudflare Access: token "tok:<email>" is accepted for that email. */
const fakeVerifier: TokenVerifier = async (token) =>
  token.startsWith("tok:") ? token.slice(4).toLowerCase() : null;

export const app = createApp(fakeVerifier);

export const EDITOR = "editor1@example.com";
export const EDITOR2 = "editor2@example.com";
export const PASTOR = "pastor@example.com";

export async function resetDb() {
  // Child tables first. Seeded fund_types (ids 1-6) and settings are kept.
  for (const t of [
    "audit_log",
    "member_titles",
    "member_status_events",
    "sync_pending",
    "expense_items",
    "expense_attachments",
    "expenses",
    "recurring_expenses",
    "offerings",
    "offering_batches",
    "budgets",
    "opening_balances",
    "members",
    "users",
    "departments",
    "expense_categories",
  ]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  await db.prepare("DELETE FROM fund_types WHERE id > 6").run();
  await db.prepare("UPDATE fund_types SET is_active = 1").run();
  await db.prepare("DELETE FROM titles WHERE id > 9").run();
  await db.prepare("UPDATE titles SET is_active = 1").run();
  await db.batch([
    db.prepare("INSERT INTO users (email, name, role) VALUES (?, ?, 'editor')").bind(EDITOR, "기록1"),
    db.prepare("INSERT INTO users (email, name, role) VALUES (?, ?, 'editor')").bind(EDITOR2, "기록2"),
    // The pastor reads the finances and manages the registry.
    db.prepare("INSERT INTO users (email, name, role, registry_admin) VALUES (?, ?, 'viewer', 1)").bind(PASTOR, "담임목사"),
    db.prepare("INSERT INTO users (email, name, role, is_active) VALUES ('sheet-sync@system.local', '목양 시트 자동 연동', 'viewer', 0)"),
    db.prepare("INSERT INTO users (email, name, role, is_active) VALUES ('scheduler@system.local', '고정 지출 자동 등록', 'viewer', 0)"),
  ]);
}

interface Opts {
  as?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  env?: Env;
}

export function call(method: string, path: string, opts: Opts = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.as) headers["Cf-Access-Jwt-Assertion"] = `tok:${opts.as}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] ??= "application/json";
  } else if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] ??= "application/json";
  }
  return app.request(`https://finance.example.org${path}`, { method, headers, body }, opts.env ?? env);
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
