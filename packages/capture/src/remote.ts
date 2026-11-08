// The `remote` capture driver: for machines without Chrome, the capture runs on a
// service that has one — the earlier project's fig-server (or its Vercel port, api/import.ts) or a future hosted capture
// service — reached over HTTP with fig-server's request and error envelope:
//
//   POST {base}/api/import/url         { url, width, alt?, menus?, height?, dpr?, timezone?, brand: true }
//                                      → the DOM snapshot (snapshot.ts shape)
//   POST {base}/api/import/url/layout  { url, width, timezone? } → { breakpoints: LayoutSwitchFound[], samples? }
//   POST {base}/api/shoot              { url, widths, height?, mobileBelow?, probe? }       (optional, CDR extension)
//                                      → { shots: [{ width, height, png: <base64>, texts?, overflowPx?, probe? }] }
//   errors: non-2xx with { error: { code, message } }; known codes map to CaptureError codes, others → capture_failed
//
// Live reference shots: fig-server has no screenshot route. When the service answers /api/shoot with 404, `shoot`
// throws CaptureError("browser_unavailable") and `capture` returns no shots (listed in `skipped`); the pipeline then
// skips the per-section checks and the measure stage ("no live shots"). Shots of the recreated output (file:// URLs,
// `guard: false`) can never be taken remotely — the service cannot read local files — so they go to `local` (a
// CdpCaptureDriver when this machine has Chrome after all); without one they fail with browser_unavailable, and live
// shots are not even requested (they could not be compared with anything).
//
// The service applies its own SSRF guard (it fetches the page); this side validates the URL first so private / local
// targets fail fast with the same codes as the cdp driver. Dependency-free: global fetch (Node ≥ 22).
import {
  CaptureError,
  DEFAULT_BUDGETS,
  type CaptureDriver,
  type CaptureOptions,
  type CaptureResult,
  type CaptureSessionPlan,
  type LayoutProbe,
  type LayoutSwitchFound,
  type ProbeOptions,
  type Shot,
  type ShotOptions,
} from "./driver.js";
import { GuardError, validateUrl } from "./guard.js";

export interface RemoteDriverOptions {
  /** `Authorization: Bearer <token>` for services behind a login (the earlier project's requireUser) */
  token?: string;
  /** shoots local outputs (file:// / guard: false); e.g. a CdpCaptureDriver when Chrome is available */
  local?: CaptureDriver;
  /** fetch implementation (tests); default the global fetch */
  fetch?: typeof fetch;
  /** time limit per request in ms (default: the capture budget + 60 s; probe 120 s) */
  timeoutMs?: number;
}

const CODES = new Set<CaptureError["code"]>([
  "browser_unavailable",
  "invalid_url",
  "blocked_address",
  "robots",
  "load_failed",
  "capture_failed",
  "cancelled",
]);

/** fig-server error codes that are not CaptureError codes */
const ALIASES: Record<string, CaptureError["code"]> = {
  bad_request: "invalid_url",
  upstream_timeout: "load_failed",
  busy: "capture_failed",
};

type Json = any;

export class RemoteCaptureDriver implements CaptureDriver {
  readonly id = "remote";
  readonly base: string;
  private readonly o: RemoteDriverOptions;

  constructor(baseUrl: string, o: RemoteDriverOptions = {}) {
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new CaptureError("invalid_url", `remote capture service: not a URL: ${baseUrl}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new CaptureError("invalid_url", `remote capture service must be http(s): ${baseUrl}`);
    this.base = u.toString().replace(/\/+$/, "");
    this.o = o;
  }

  private check(url: string, guard: CaptureOptions["guard"]): string {
    try {
      return validateUrl(url, guard ?? {}).toString();
    } catch (e) {
      if (e instanceof GuardError)
        throw new CaptureError(e.code === "blocked_address" ? "blocked_address" : "invalid_url", e.message);
      throw new CaptureError("invalid_url", (e as Error).message);
    }
  }

  /** POST JSON → parsed JSON; errors as CaptureError. `null` when the route does not exist (404 without envelope). */
  private async post(
    route: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Json | null> {
    if (signal?.aborted) throw new CaptureError("cancelled", "Cancelled.");
    const timer = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timer]) : timer;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(`${this.base}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: sig,
      });
    } catch (e) {
      if (signal?.aborted) throw new CaptureError("cancelled", "Cancelled.");
      if (timer.aborted)
        throw new CaptureError("load_failed", `remote capture service timed out after ${timeoutMs} ms`);
      throw new CaptureError(
        "browser_unavailable",
        `remote capture service not reachable at ${this.base} (${(e as Error).message})`,
      );
    }
    const text = await res.text().catch(() => "");
    let json: Json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (res.ok) {
      if (json === null || typeof json !== "object")
        throw new CaptureError(
          "capture_failed",
          `remote capture service returned an unreadable answer for ${route}`,
        );
      return json;
    }
    const err = json?.error;
    if (res.status === 404 && !err?.code) return null;
    const raw = typeof err?.code === "string" ? err.code : "";
    const code: CaptureError["code"] = CODES.has(raw as CaptureError["code"])
      ? (raw as CaptureError["code"])
      : (ALIASES[raw] ??
        (res.status >= 502 && res.status <= 504 && !err ? "browser_unavailable" : "capture_failed"));
    const message = typeof err?.message === "string" ? err.message : `HTTP ${res.status}`;
    throw new CaptureError(code, `remote capture (${route}): ${message}`);
  }

  async probe(url: string, o: ProbeOptions = {}): Promise<LayoutProbe> {
    const t0 = Date.now();
    const target = this.check(url, o.guard);
    const body = await this.post(
      "/api/import/url/layout",
      {
        url: target,
        width: o.width ?? 1440,
        ...(o.height ? { height: o.height } : {}),
        ...(o.timezone ? { timezone: o.timezone } : {}),
      },
      this.o.timeoutMs ?? Math.max(120_000, (o.budgetMs ?? 35_000) + 60_000),
      o.signal,
    );
    if (!body)
      throw new CaptureError("capture_failed", "remote capture service has no /api/import/url/layout route");
    const breakpoints: LayoutSwitchFound[] = Array.isArray(body.breakpoints)
      ? body.breakpoints.filter((b: Json) => b && typeof b.px === "number")
      : [];
    if (!Array.isArray(body.breakpoints))
      throw new CaptureError("capture_failed", "remote layout probe answered without `breakpoints`");
    return {
      url: typeof body.url === "string" ? body.url : target,
      breakpoints: breakpoints.map((b) => ({ ...b, rules: b.rules ?? 0, source: b.source ?? "media" })),
      samples: typeof body.samples === "number" ? body.samples : 0,
      ms: Date.now() - t0,
    };
  }

  async capture(url: string, plan: CaptureSessionPlan, o: CaptureOptions = {}): Promise<CaptureResult> {
    const t0 = Date.now();
    const target = this.check(url, o.guard);
    const budgets = { ...DEFAULT_BUDGETS, ...o.budgets };
    const width = Math.round(Math.max(320, Math.min(2560, plan.width)));
    const log = (m: string) => o.log?.(`${m} (${Date.now() - t0} ms)`);
    log(`remote capture ${this.base}`);
    const snapshot = await this.post(
      "/api/import/url",
      {
        url: target,
        width,
        ...(plan.alt?.length ? { alt: plan.alt } : {}),
        ...(plan.menus?.length ? { menus: plan.menus } : {}),
        ...(o.height ? { height: o.height } : {}),
        ...(o.dpr ? { dpr: o.dpr } : {}),
        ...(o.timezone ? { timezone: o.timezone } : {}),
        brand: true,
      },
      this.o.timeoutMs ?? budgets.totalMs + 60_000,
      o.signal,
    );
    if (!snapshot)
      throw new CaptureError("browser_unavailable", `${this.base} has no /api/import/url capture route`);
    if (!snapshot.root) throw new CaptureError("capture_failed", "remote capture returned no DOM tree");
    log("snapshot received");
    const skipped: string[] = Array.isArray(snapshot.skipped)
      ? snapshot.skipped.filter((x: unknown) => typeof x === "string")
      : [];
    let shots: Shot[] = [];
    if (o.shotWidths?.length) {
      if (!this.o.local)
        skipped.push("live shots (remote driver without a local browser to shoot the output)");
      else
        try {
          shots = await this.shoot(target, o.shotWidths, {
            signal: o.signal,
            guard: o.guard,
            probe: o.shotProbe,
          });
          for (const shot of shots)
            try {
              o.onShot?.(shot);
            } catch {
              /* a listener never fails the capture */
            }
        } catch (e) {
          if (e instanceof CaptureError && e.code === "cancelled") throw e;
          skipped.push(`live shots (${(e as Error).message})`);
        }
    }
    let probes: Shot[] = [];
    if (o.probeWidths?.length && this.o.local)
      try {
        probes = await this.shoot(target, o.probeWidths, {
          signal: o.signal,
          guard: o.guard,
          probe: o.shotProbe,
          factsOnly: true,
        });
        for (const p of probes)
          try {
            o.onProbe?.(p);
          } catch {
            /* a listener never fails the capture */
          }
      } catch (e) {
        if (e instanceof CaptureError && e.code === "cancelled") throw e;
        skipped.push(`layout facts (${(e as Error).message})`);
      }
    const finalUrl =
      typeof snapshot.finalUrl === "string"
        ? snapshot.finalUrl
        : typeof snapshot.url === "string"
          ? snapshot.url
          : target;
    return { snapshot, finalUrl, skipped, shots, ...(probes.length ? { probes } : {}), ms: Date.now() - t0 };
  }

  async shoot(url: string, widths: number[], o: ShotOptions = {}): Promise<Shot[]> {
    // the recreated output lives on this machine: only a local browser can load it
    if (o.guard === false || /^file:/i.test(url)) {
      if (this.o.local) return this.o.local.shoot(url, widths, o);
      throw new CaptureError(
        "browser_unavailable",
        "the remote capture driver cannot screenshot local files (the recreated output); install Chrome or set HARNESS_CHROME to measure",
      );
    }
    const target = this.check(url, o.guard);
    const body = await this.post(
      "/api/shoot",
      {
        url: target,
        widths,
        ...(o.height ? { height: o.height } : {}),
        ...(o.mobileBelow !== undefined ? { mobileBelow: o.mobileBelow } : {}),
        ...(o.probe ? { probe: o.probe } : {}),
      },
      this.o.timeoutMs ?? 60_000 + widths.length * 30_000,
      o.signal,
    );
    if (!body)
      throw new CaptureError(
        "browser_unavailable",
        `${this.base} offers no /api/shoot route: live reference shots need the cdp driver (local Chrome)`,
      );
    if (!Array.isArray(body.shots))
      throw new CaptureError("capture_failed", "remote /api/shoot answered without `shots`");
    return body.shots.map((s: Json): Shot => ({
      width: Number(s.width),
      height: Number(s.height),
      png: Buffer.from(String(s.png ?? ""), "base64"),
      ...(Array.isArray(s.texts) ? { texts: s.texts } : {}),
      ...(typeof s.overflowPx === "number" ? { overflowPx: s.overflowPx } : {}),
      ...(s.probe !== undefined ? { probe: s.probe } : {}),
    }));
  }
}
