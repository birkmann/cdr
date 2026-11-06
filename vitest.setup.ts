import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// macOS reports temp dirs as /var/folders/... while the app canonicalises project
// roots with realpath (/private/var/folders/...). Pin one spelling so tests and the
// code they exercise compare the same absolute paths.
process.env.TMPDIR = realpathSync(tmpdir());

// Isolate ~/.harness (sessions, locks, memory) per test worker.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-home-"));

// Chats put the files they create in ~/Documents/CDR by default; keep tests out of the real home.
process.env.CDR_OUTPUT_DIR = mkdtempSync(join(tmpdir(), "harness-output-"));
