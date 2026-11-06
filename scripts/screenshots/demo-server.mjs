#!/usr/bin/env node
// `cdr serve` with the scripted demo model. Accepts the sidecar flags CDR Studio passes
// (serve --host --port --token-env --ready-json --origin), so it can stand in via CDR_HARNESS_ENTRY.
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createDemoHarness } from "./demo-model.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { startServer } = await import(join(root, "packages/server/dist/index.js"));
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "serve"),
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" },
    "token-env": { type: "string" },
    token: { type: "string" },
    "ready-json": { type: "boolean" },
    origin: { type: "string", multiple: true },
    static: { type: "string" },
  },
});
const token = values["token-env"] ? process.env[values["token-env"]] : (values.token ?? "demo-token");
const webDist = join(root, "apps/web/dist");
const s = await startServer({
  harness: createDemoHarness(),
  token,
  host: values.host,
  port: Number(values.port),
  origins: values.origin,
  staticDir: values.static ?? (existsSync(join(webDist, "index.html")) ? webDist : undefined),
});
if (values["ready-json"]) process.stdout.write(JSON.stringify({ ready: true, url: s.url, port: s.port }) + "\n");
else process.stdout.write(`demo server: ${s.url}/#token=${token}\n`);
const parent = Number(process.env.CDR_PARENT_PID);
const stop = () => s.close().then(() => process.exit(0));
if (parent > 0)
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      void stop();
    }
  }, 1000);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
