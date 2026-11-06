// robots.txt for `recreate.respectRobots`: a capture does not load a URL that robots.txt disallows for every crawler
// (`User-agent: *`). Longest matching rule wins, Allow wins ties (RFC 9309); `*` and `$` patterns are understood.
import { fetchPublic, type GuardOptions } from "./guard.js";

interface Rule {
  allow: boolean;
  pattern: string;
}

/** The rules of the `User-agent: *` group(s) of a robots.txt. */
export function parseRobots(text: string): Rule[] {
  const rules: Rule[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (inRules) {
        agents = [];
        inRules = false;
      }
      agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      if (!agents.includes("*")) continue;
      // an empty Disallow allows everything
      if (!value) continue;
      rules.push({ allow: key === "allow", pattern: value });
    }
  }
  return rules;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    "^" +
      body
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      (anchored ? "$" : ""),
  );
  return re.test(path);
}

/** Is `url`'s path allowed by these rules? */
export function robotsAllow(rules: Rule[], url: URL): boolean {
  const path = url.pathname + url.search;
  let best: Rule | null = null;
  for (const r of rules) {
    if (!matches(r.pattern, path)) continue;
    if (
      !best ||
      r.pattern.length > best.pattern.length ||
      (r.pattern.length === best.pattern.length && r.allow)
    )
      best = r;
  }
  return best ? best.allow : true;
}

/** Fetch `<origin>/robots.txt` and check `url` (a missing or unreadable robots.txt allows everything). */
export async function checkRobots(
  url: string,
  o: GuardOptions & { userAgent?: string } = {},
): Promise<{ allowed: boolean; rule?: string }> {
  const u = new URL(url);
  const res = await fetchPublic(
    `${u.origin}/robots.txt`,
    { "user-agent": o.userAgent ?? "Mozilla/5.0", accept: "text/plain" },
    512 * 1024,
    8_000,
    o,
  ).catch(() => null);
  if (!res) return { allowed: true };
  const rules = parseRobots(res.body.toString("utf8"));
  const allowed = robotsAllow(rules, u);
  return allowed ? { allowed } : { allowed, rule: "robots.txt disallows this path for all crawlers" };
}
