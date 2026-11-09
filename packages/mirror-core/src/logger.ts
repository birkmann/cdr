/**
 * Minimal structured logger. Writes to stderr (stdout stays clean for machine output), redacts secret env values.
 * Verbosity: `setLogLevel("debug")`, or env `CMP_LOG_LEVEL=debug` / `CMP_VERBOSE=1`.
 */
import type { Logger } from "./contracts.js";
import { redactSecrets } from "./env.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let globalLevel: LogLevel | undefined;
export function setLogLevel(level: LogLevel | undefined): void {
  globalLevel = level;
}
function currentLevel(): LogLevel {
  if (globalLevel) return globalLevel;
  const env = process.env.CMP_LOG_LEVEL as LogLevel | undefined;
  if (env && env in ORDER) return env;
  if (process.env.CMP_VERBOSE === "1" || process.env.CMP_VERBOSE === "true") return "debug";
  return "info";
}

export interface LoggerOptions {
  level?: LogLevel;
  /** sink for formatted lines (tests); default process.stderr */
  write?: (line: string) => void;
  /** emit JSON lines instead of human-readable text (env CMP_LOG_JSON=1) */
  json?: boolean;
}

function fmtData(data: unknown): string {
  if (data === undefined) return "";
  if (data instanceof Error) return ` ${data.stack ?? data.message}`;
  try {
    return " " + (typeof data === "string" ? data : JSON.stringify(data));
  } catch {
    return " [unserializable]";
  }
}

export function createLogger(step: string, opts: LoggerOptions = {}): Logger {
  const write = opts.write ?? ((l: string) => process.stderr.write(l + "\n"));
  const json = opts.json ?? process.env.CMP_LOG_JSON === "1";
  const emit = (level: Exclude<LogLevel, "silent">, msg: string, data?: unknown) => {
    const min = opts.level ?? currentLevel();
    if (ORDER[level] < ORDER[min]) return;
    let line: string;
    if (json) {
      line = JSON.stringify({ ts: new Date().toISOString(), level, step, msg, data: data instanceof Error ? { message: data.message } : data });
    } else {
      const t = new Date().toISOString().slice(11, 19);
      const tag = level === "info" ? "" : ` ${level.toUpperCase()}`;
      line = `${t} [${step}]${tag} ${msg}${fmtData(data)}`;
    }
    write(redactSecrets(line));
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}

/** Logger that drops everything (tests, library defaults). */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
