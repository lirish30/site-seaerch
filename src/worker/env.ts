export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  /** Cloudflare Browser Rendering; optional so the app still runs (rules-only audits) without it. */
  BROWSER?: Fetcher;
  LEAD_WORKFLOW: Workflow;
  SEARCH_WORKFLOW: Workflow;
  CRO_AUDIT_WORKFLOW: Workflow;
  VIDEO_WORKFLOW: Workflow;
  LOGIN_LIMITER?: RateLimit;
  /** Throttles the public booking routes per report link and client IP. Optional, like LOGIN_LIMITER. */
  BOOKING_LIMITER?: RateLimit;
  /** Throttles a client's proposal page and signing per proposal link and client IP. Optional, like the others. */
  CLIENT_LIMITER?: RateLimit;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  /** Bearer token for the /mcp endpoint (Worker secret). */
  MCP_TOKEN: string;
  BRIGHTDATA_API_KEY: string;
  BRIGHTDATA_SERP_ZONE: string;
  /** Optional: Google Places API (New) key. When set, listings come from Places first and Bright Data is the fallback. */
  GOOGLE_PLACES_API_KEY?: string;
  PAGESPEED_API_KEY: string;
  /** Optional: Google OAuth client for the Drive export. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional passkey overrides. When unset, the request URL's hostname is the RP ID and its origin the expected origin. */
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_ORIGIN?: string;
  /** Mailbox passwords (Worker secrets, never stored in D1). */
  MAILBOX_OUTREACH_PASSWORD?: string;
  MAILBOX_MAIN_PASSWORD?: string;
  /** Base URL for tracked outreach links (e.g. https://go.hellositeline.com). */
  OUTREACH_LINK_BASE?: string;
  /** Base URL for a client's proposal link (https only, e.g. https://clients.hellositeline.com). Never the cold-email host and never workers.dev. */
  CLIENT_LINK_BASE?: string;
}
