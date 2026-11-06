import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { licensesPlugin } from "../../scripts/licenses.mjs";
import { fileURLToPath } from "node:url";

// The desktop UI reuses the web app's chat, pickers, and styles from apps/web/src via "@web".
export default defineConfig({
  plugins: [react(), licensesPlugin("the CDR Studio interface")],
  clearScreen: false,
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: { "@web": fileURLToPath(new URL("../web/src", import.meta.url)) },
  },
  server: { port: 5174, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 3000,
    sourcemap: false,
    // Keep the ~1,250 file-type icons as separate files instead of inlining them into the bundle.
    assetsInlineLimit: (file: string) => (file.includes("material-icon-theme") ? false : undefined),
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as any);
