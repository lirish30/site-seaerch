import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_PASSWORD: "test-pass", MCP_TOKEN: "test-mcp-token",
            SESSION_SECRET: "test-secret-test-secret-test-secret",
            BRIGHTDATA_API_KEY: "x", BRIGHTDATA_SERP_ZONE: "x",
            PAGESPEED_API_KEY: "x", ANTHROPIC_API_KEY: "x",
            WEBAUTHN_RP_ID: "x", WEBAUTHN_ORIGIN: "https://x",
            MAILBOX_OUTREACH_PASSWORD: "pw-out", MAILBOX_MAIN_PASSWORD: "pw-main",
            OUTREACH_LINK_BASE: "https://go.hellositeline.test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
