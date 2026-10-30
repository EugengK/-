export type Role = "editor" | "viewer";

export interface AppUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  /** May change the 교적부 (people, titles, attendance status). */
  registry_admin: boolean;
}

export interface Env {
  DB: D1Database;
  /** Receipt photos (R2). */
  RECEIPTS: R2Bucket;
  ENVIRONMENT: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_AUTH_EMAIL?: string;
  /** Shared secret the pastor's sheet script sends to /api/registry/sync (wrangler secret). */
  SYNC_TOKEN?: string;
  /** Receipt auto-read (Google Gemini, paid tier). Secret: wrangler secret put GEMINI_API_KEY */
  GEMINI_API_KEY?: string;
  /** Gemini model id, e.g. "gemini-3.5-flash" (wrangler.jsonc vars). */
  GEMINI_MODEL?: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: AppUser } };

/** Turns the Cloudflare Access token into a verified, lower-cased email, or null. */
export type TokenVerifier = (token: string, env: Env) => Promise<string | null>;
