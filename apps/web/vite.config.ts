import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  // @harness/react has react as a dev dependency; make sure only one copy is bundled.
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    port: 5173,
    host: "127.0.0.1",
    // In dev, the API runs on `harness serve` (8787); proxy it so the app can use same-origin URLs.
    proxy: Object.fromEntries(["/sessions", "/models", "/browse", "/health", "/preview"].map((p) => [p, { target: api, changeOrigin: false }])),
  },
});
