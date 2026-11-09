import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // The bundled workerd binary supports up to 2026-08-22; production stays on 2026-11-01.
        compatibilityDate: "2026-08-22",
        bindings: {
          MCP_HOST: "mcp.test",
          HOOKS_HOST: "hooks.test",
          OPENAI_API_KEY: "sk-test-openai",
          OPENAI_WEBHOOK_SECRET: "whsec_test",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
