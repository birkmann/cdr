import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate ~/.harness (sessions, locks, memory) per test worker.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-home-"));
