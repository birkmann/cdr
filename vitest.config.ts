import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@harness/cli/tui": fileURLToPath(new URL("./packages/cli/src/tui/index.ts", import.meta.url)),
      "@harness/protocol": src("protocol"),
      "@harness/core": src("core"),
      "@harness/server": src("server"),
      "@harness/client": src("client"),
      "@harness/react": src("react"),
      "@harness/capture": src("capture"),
      "@harness/scene": src("scene"),
      "@harness/extract": src("extract"),
      "@harness/codegen": src("codegen"),
      "@harness/measure": src("measure"),
      "@harness/recreate": src("recreate"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}", "apps/desktop/src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
    pool: "forks",
  },
});
