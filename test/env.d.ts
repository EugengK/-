declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    RECEIPTS: R2Bucket;
    ENVIRONMENT: string;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    DEV_AUTH_EMAIL?: string;
    GEMINI_API_KEY?: string;
    GEMINI_MODEL?: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
