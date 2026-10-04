export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  /** Cloudflare Browser Rendering; optional so the app still runs (rules-only audits) without it. */
  BROWSER?: Fetcher;
  LEAD_WORKFLOW: Workflow;
  SEARCH_WORKFLOW: Workflow;
  CRO_AUDIT_WORKFLOW: Workflow;
  LOGIN_LIMITER?: RateLimit;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  BRIGHTDATA_API_KEY: string;
  BRIGHTDATA_SERP_ZONE: string;
  PAGESPEED_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  /** Optional: Google OAuth client for Gmail drafts and Drive export. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
