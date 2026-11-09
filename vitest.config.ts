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
      "@harness/design-system": src("design-system"),
      "@harness/mirror-core": src("mirror-core"),
      "@harness/mirror-transforms": src("mirror-transforms"),
      "@harness/mirror-capture": src("mirror-capture"),
      "@harness/mirror-design": src("mirror-design"),
      "@harness/mirror-generate": src("mirror-generate"),
      "@harness/mirror-verify": src("mirror-verify"),
      "@harness/mirror-fix": src("mirror-fix"),
      "@harness/mirror": src("mirror"),
      "@harness/mirror-replay": src("mirror-replay"),
      "@harness/autopilot": src("autopilot"),
      "@web": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}", "apps/desktop/src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 60_000,
    pool: "forks",
  },
});
