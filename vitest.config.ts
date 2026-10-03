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
            APP_PASSWORD: "test-pass",
            SESSION_SECRET: "test-secret-test-secret-test-secret",
            BRIGHTDATA_API_KEY: "x", BRIGHTDATA_SERP_ZONE: "x",
            PAGESPEED_API_KEY: "x", ANTHROPIC_API_KEY: "x",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
