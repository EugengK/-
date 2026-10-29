import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { MiddlewareHandler } from "hono";
import { isPhotoUpload, PHOTO_TYPES } from "./routes/attachments";
import type { AppEnv, AppUser, Env, TokenVerifier } from "./types";

const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

/**
 * Verifies a Cloudflare Access JWT (signature, issuer, audience, expiry).
 * Returns the user's lower-cased email, or null for anything that is not a valid user token
 * (including service tokens, which carry no email).
 */
export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string; keys: JWTVerifyGetKey },
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, opts.keys, {
      issuer: `https://${opts.teamDomain}`,
      audience: opts.aud,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    });
    const email = payload["email"];
    if (typeof email !== "string" || !email.includes("@")) return null;
    return email.toLowerCase();
  } catch {
    return null;
  }
}

const jwksByTeam = new Map<string, JWTVerifyGetKey>();

export const accessVerifier: TokenVerifier = async (token, env) => {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  // Not configured -> nobody gets in.
  if (!teamDomain || !aud) return null;
  let keys = jwksByTeam.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, keys);
  }
  return verifyAccessJwt(token, { teamDomain, aud, keys });
};

/** Local-development shortcut. Requires ENVIRONMENT=development AND a localhost request. */
function devEmail(env: Env, requestUrl: string): string | null {
  if (env.ENVIRONMENT !== "development" || !env.DEV_AUTH_EMAIL) return null;
  const host = new URL(requestUrl).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return null;
  return env.DEV_AUTH_EMAIL.toLowerCase();
}

export function authenticate(verify: TokenVerifier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let email = devEmail(c.env, c.req.url);
    if (!email) {
      const token = c.req.header(ACCESS_HEADER);
      if (!token) return c.json({ error: "로그인이 필요합니다." }, 401);
      email = await verify(token, c.env);
      if (!email) return c.json({ error: "로그인이 필요합니다." }, 401);
    }
    const row = await c.env.DB.prepare(
      "SELECT id, email, name, role, registry_admin FROM users WHERE email = ? AND is_active = 1",
    )
      .bind(email)
      .first<Omit<AppUser, "registry_admin"> & { registry_admin: number }>();
    if (!row) return c.json({ error: "이 계정은 사용 권한이 없습니다." }, 403);
    c.set("user", { ...row, registry_admin: row.registry_admin === 1 });
    await next();
  };
}

function isSameHost(origin: string, requestUrl: string): boolean {
  try {
    return new URL(origin).origin === new URL(requestUrl).origin;
  } catch {
    return false; // e.g. Origin: "null"
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const isRegistryPath = (path: string) => path === "/api/registry" || path.startsWith("/api/registry/");

/**
 * The 교적부 (birth dates, families, attendance history, notes) is the pastor's. Finance editors
 * cannot read it either; they get only what offering entry needs from GET /api/members.
 */
/** Reports, the change log and settings are the pastor's view of the books. */
export const pastorOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user").registry_admin) return c.json({ error: "담임목사만 볼 수 있습니다." }, 403);
  await next();
};

export const guardRegistryReads: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isRegistryPath(c.req.path) && !c.get("user").registry_admin) {
    return c.json({ error: "교적부는 교적부 관리 권한이 있는 분만 볼 수 있습니다." }, 403);
  }
  await next();
};

/** Lists everyone picks from (offering types, departments, expense categories), and the opening balances. */
const LIST_PATHS = ["/api/fund-types", "/api/departments", "/api/expense-categories", "/api/opening-balances"];

/**
 * The pastor (registry_admin) keeps the members and the lists everyone picks from; finance
 * editors record offerings and expenses.
 */
function mayWrite(user: AppUser, path: string): boolean {
  if (isRegistryPath(path) || path.startsWith("/api/members") || LIST_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
    return user.registry_admin;
  }
  return user.role === "editor";
}

/**
 * Default-deny for writes: any non-read request needs the right permission for its area, a same-origin
 * Origin (if the browser sent one) and a JSON body. The last two close the CSRF gap
 * that cookie-based Access login would otherwise leave open.
 */
export const guardWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  if (!mayWrite(c.get("user"), c.req.path)) {
    return c.json({ error: "수정 권한이 없습니다." }, 403);
  }
  const origin = c.req.header("Origin");
  if (origin !== undefined && !isSameHost(origin, c.req.url)) {
    return c.json({ error: "허용되지 않은 요청 출처입니다." }, 403);
  }
  const type = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  // A receipt photo is sent as the image itself. Like JSON, an image type can't come from a plain
  // cross-site form (it forces a CORS preflight), so CSRF protection is the same.
  const photo = isPhotoUpload(c.req.path) && PHOTO_TYPES.has(type);
  if (type !== "application/json" && !photo) {
    return c.json({ error: "JSON 형식으로 요청해야 합니다." }, 415);
  }
  return next();
};
