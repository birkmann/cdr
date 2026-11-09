import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
// template unit tests: pnpm vitest run --config templates/nextjs-contentful/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  esbuild: { jsx: "automatic" },
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"], exclude: ["**/node_modules/**"], testTimeout: 30_000 },
});
