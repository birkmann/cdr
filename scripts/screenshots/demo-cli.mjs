#!/usr/bin/env node
// The real `cdr` CLI, wired to the scripted demo model. Usage: node demo-cli.mjs [cdr args…]
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDemoHarness } from "./demo-model.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { main } = await import(join(root, "packages/cli/dist/index.js"));
const code = await main(process.argv.slice(2), { harness: createDemoHarness() });
process.exit(code);
