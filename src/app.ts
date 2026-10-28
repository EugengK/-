import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { accessVerifier, authenticate, guardWrites } from "./auth";
import { expenseRoutes, recurringRoutes } from "./routes/expenses";
import { lookupRoutes } from "./routes/lookups";
import { auditRoutes, meRoutes, settingsRoutes, userRoutes } from "./routes/misc";
import { memberRoutes } from "./routes/members";
import { offeringRoutes } from "./routes/offerings";
import { openingBalanceRoutes } from "./routes/openingBalances";
import { registryRoutes } from "./routes/registry";
import { reportRoutes } from "./routes/reports";
import { syncRoutes } from "./routes/sync";
import type { AppEnv, TokenVerifier } from "./types";

/** `verify` is injectable so tests can stand in for Cloudflare Access; production uses the default. */
export function createApp(verify: TokenVerifier = accessVerifier) {
  const app = new Hono<AppEnv>();

  // API responses are data only: never framed, never sniffed, never cached by shared caches.
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
  });

  // Open on purpose: no data, used for uptime checks.
  app.get("/api/health", (c) => c.json({ ok: true }));

  // The pastor's sheet script authenticates with its own token, not a user login.
  app.route("/api/registry/sync", syncRoutes);

  app.use("/api/*", authenticate(verify));
  app.use("/api/*", guardWrites);

  app.route("/api/me", meRoutes);
  app.route("/api/users", userRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/audit-log", auditRoutes);
  app.route("/api/fund-types", lookupRoutes("fund_types"));
  app.route("/api/departments", lookupRoutes("departments"));
  app.route("/api/expense-categories", lookupRoutes("expense_categories"));
  app.route("/api/opening-balances", openingBalanceRoutes);
  app.route("/api/members", memberRoutes);
  app.route("/api/offerings", offeringRoutes);
  app.route("/api/registry", registryRoutes);
  app.route("/api/expenses", expenseRoutes);
  app.route("/api/recurring-expenses", recurringRoutes);
  app.route("/api/reports", reportRoutes);

  app.notFound((c) => c.json({ error: "찾을 수 없습니다." }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "서버 오류가 발생했습니다." }, 500);
  });

  return app;
}
