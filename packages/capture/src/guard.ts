// SSRF guard for the capture: ported from the earlier project's api/_lib/guard.ts (itself a port of fig-server's
// fetch.rs). http(s) only, no credentials, no local host names, and every address a host resolves to must be public.
// `fetchPublic` pins the connection to the checked addresses. `allowLocal` (tests against fixture sites, or a user who
// explicitly allows converting their own localhost site) lifts the private-address rules and nothing else.
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

export class GuardError extends Error {
  constructor(
    readonly code: "invalid_url" | "blocked_address" | "unreachable",
    message: string,
  ) {
    super(message);
  }
}

export interface GuardOptions {
  /** allow loopback / private addresses and local host names (default false) */
  allowLocal?: boolean;
}

/** `localhost`, `*.localhost`, `*.local` (mDNS) and `*.internal` (cloud-internal DNS). */
export function isBlockedHostname(host: string): boolean {
  const h = host.replace(/\.+$/, "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "local" ||
    h.endsWith(".local") ||
    h === "internal" ||
    h.endsWith(".internal")
  );
}

function blockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8 "this network" (incl. unspecified)
    a === 10 || // 10/8 private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // 224/4 multicast, 240/4 reserved, broadcast
  );
}

/** Eight 16-bit segments of an IPv6 address (`::` expanded, a dotted IPv4 tail folded in), or null. */
function v6Segments(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const o = dotted[1].split(".").map(Number);
    s = `${s.slice(0, -dotted[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const parts = (x: string | undefined) => (x ? x.split(":") : []);
  const h = parts(head),
    t = parts(tail);
  const fill = s.includes("::") ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array<string>(Math.max(0, fill)).fill("0"), ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((x) => x >= 0 && x <= 0xffff) ? all : null;
}

/** IPv4 addresses carried inside an IPv6 address: mapped, compatible, translated, NAT64 and 6to4. */
function embeddedV4(s: number[]): number[][] {
  const tail = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const out: number[][] = [];
  if (s.slice(0, 5).every((x) => x === 0) && (s[5] === 0xffff || s[5] === 0)) out.push(tail(s[6], s[7]));
  if (s.slice(0, 4).every((x) => x === 0) && s[4] === 0xffff && s[5] === 0) out.push(tail(s[6], s[7]));
  if (s[0] === 0x0064 && s[1] === 0xff9b && s.slice(2, 6).every((x) => x === 0)) out.push(tail(s[6], s[7]));
  if (s[0] === 0x2002) out.push(tail(s[1], s[2]));
  return out;
}

/** True for every address a capture must never reach. */
export function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) return blockedV4(ip.split(".").map(Number));
  const s = v6Segments(ip);
  if (!s) return true;
  if (embeddedV4(s).some(blockedV4)) return true;
  return (
    s.every((x) => x === 0) || // unspecified
    (s.slice(0, 7).every((x) => x === 0) && s[7] === 1) || // loopback
    (s[0] & 0xff00) === 0xff00 || // ff00::/8 multicast
    (s[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (s[0] & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (s[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (s[0] === 0x2001 && s[1] === 0x0db8) || // documentation
    (s[0] === 0x3fff && s[1] < 0x1000) || // 3fff::/20 documentation
    (s[0] === 0x2001 && s[1] === 0) || // Teredo
    (s[0] === 0x2001 && s[1] === 2 && s[2] === 0) || // benchmarking
    (s[0] === 0x0100 && s[1] === 0 && s[2] === 0 && s[3] === 0) // discard
  );
}

/** Link-local / metadata addresses stay blocked even with `allowLocal` (cloud credentials live there). */
function alwaysBlocked(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 169 && b === 254;
  }
  const s = v6Segments(ip);
  return !s || (s[0] & 0xffc0) === 0xfe80;
}

const blockedFor = (ip: string, o: GuardOptions) => (o.allowLocal ? alwaysBlocked(ip) : isBlockedIp(ip));

/** Parse and check a target URL (no DNS). */
export function validateUrl(raw: string, o: GuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new GuardError("invalid_url", `not a valid URL: ${(e as Error).message}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new GuardError("invalid_url", `only http and https URLs can be captured, got ${url.protocol}`);
  if (url.username || url.password)
    throw new GuardError("invalid_url", "URLs with credentials (user:pass@) are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new GuardError("invalid_url", "the URL has no host");
  if (isIP(host)) {
    if (blockedFor(host, o)) throw new GuardError("blocked_address", `${host} is not a public address`);
  } else if (!o.allowLocal && isBlockedHostname(host))
    throw new GuardError("blocked_address", `${host} is a local host name`);
  return url;
}

/** Resolve the URL's host and refuse when any address is blocked. IP literals need no DNS. */
export async function resolveChecked(url: URL, o: GuardOptions = {}): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (blockedFor(host, o)) throw new GuardError("blocked_address", `${host} is not a public address`);
    return [host];
  }
  if (!o.allowLocal && isBlockedHostname(host))
    throw new GuardError("blocked_address", `${host} is a local host name`);
  let addrs: string[];
  try {
    addrs = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch (e) {
    throw new GuardError("unreachable", `could not resolve ${host}: ${(e as Error).message}`);
  }
  if (!addrs.length) throw new GuardError("unreachable", `${host} has no addresses`);
  const bad = addrs.find((a) => blockedFor(a, o));
  if (bad)
    throw new GuardError("blocked_address", `${host} resolves to ${bad}, which is not a public address`);
  return addrs;
}

/** host:port → allowed? (resolved once per capture) */
export class HostGuard {
  private readonly decisions = new Map<string, Promise<boolean>>();
  constructor(readonly options: GuardOptions = {}) {}

  allowed(raw: string): Promise<boolean> {
    let url: URL;
    try {
      url = validateUrl(raw, this.options);
    } catch {
      return Promise.resolve(false);
    }
    const key = `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
    let d = this.decisions.get(key);
    if (!d) {
      d = resolveChecked(url, this.options).then(
        () => true,
        () => false,
      );
      this.decisions.set(key, d);
    }
    return d;
  }
}

/**
 * GET with the connection pinned to checked addresses; redirects followed by hand, every hop checked again.
 * → (content type, bytes), or null (blocked, failed, not 2xx, larger than `maxBytes`).
 */
export async function fetchPublic(
  raw: string,
  headers: Record<string, string>,
  maxBytes: number,
  timeoutMs: number,
  o: GuardOptions = {},
): Promise<{ type: string; body: Buffer } | null> {
  let cur = raw;
  for (let hop = 0; hop < 5; hop++) {
    let url: URL, addrs: string[];
    try {
      url = validateUrl(cur, o);
      addrs = await resolveChecked(url, o);
    } catch {
      return null;
    }
    // IPv4 first; the socket connects to exactly these addresses (no second DNS answer can redirect it)
    const pinned = [...addrs].sort((a, b) => isIP(a) - isIP(b));
    const pin: LookupFunction = (_host, opts, cb) => {
      if ((opts as { all?: boolean }).all)
        cb(
          null,
          pinned.map((address) => ({ address, family: isIP(address) })),
        );
      else cb(null, pinned[0], isIP(pinned[0]));
    };
    const res = await new Promise<{ status: number; location?: string; type: string; body: Buffer } | null>(
      (resolve) => {
        const req = (url.protocol === "https:" ? https : http).get(
          url,
          { headers, lookup: pin, timeout: timeoutMs },
          (r) => {
            const status = r.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              r.resume();
              resolve({ status, location: r.headers.location, type: "", body: Buffer.alloc(0) });
              return;
            }
            if (status < 200 || status >= 300 || Number(r.headers["content-length"] ?? 0) > maxBytes) {
              r.resume();
              resolve(null);
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            r.on("data", (c: Buffer) => {
              size += c.length;
              if (size > maxBytes) {
                req.destroy();
                resolve(null);
              } else chunks.push(c);
            });
            r.on("end", () =>
              resolve({
                status,
                type: String(r.headers["content-type"] ?? "").toLowerCase(),
                body: Buffer.concat(chunks),
              }),
            );
            r.on("error", () => resolve(null));
          },
        );
        req.on("timeout", () => {
          req.destroy();
          resolve(null);
        });
        req.on("error", () => resolve(null));
      },
    );
    if (!res) return null;
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) return null;
      cur = new URL(res.location, url).toString();
      continue;
    }
    return { type: res.type, body: res.body };
  }
  return null;
}
