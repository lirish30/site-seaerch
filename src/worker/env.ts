export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  ASSETS: Fetcher;
  LEAD_WORKFLOW: Workflow;
  SEARCH_WORKFLOW: Workflow;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  BRIGHTDATA_API_KEY: string;
  BRIGHTDATA_SERP_ZONE: string;
  PAGESPEED_API_KEY: string;
  ANTHROPIC_API_KEY: string;
}
