import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The helper's own test run: plain Node, nothing from the Worker's pool. `npm run test:helper` at the repo root points here. */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
