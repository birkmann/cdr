/**
 * Which captured HTML of a crawled page is "the content": the raw server HTML (default) or the browser-rendered DOM.
 *
 * Client-rendered content: the server HTML of a Next.js app (news, disruptions … fetched in the browser) holds skeletons
 * where the visitor sees content. When the rendered <main> is a superset of the server HTML's words (adds content,
 * loses none), the rendered DOM is the content source. Drupal pages stay raw-first (theme JS clones slides and injects
 * widgets; the server HTML is the truth there), and so do web-component pages (their own JS upgrades the server markup
 * in the generated app, see @cmp/design).
 *
 * One decision, used by every consumer of a page's content: the CCM build (to-ccm.ts), the text-coverage report
 * (infer.ts) and verify's old-side fetch (@cmp/verify renders the live page in a browser for these pages, otherwise the
 * server HTML is compared with an app that shows the rendered content).
 */

/** Distinct words (≥ 3 letters/digits) of the <main> text (whole body without one); scripts/styles/templates skipped. */
export function mainWords(html: string): Set<string> {
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] ?? html.slice(Math.max(0, html.search(/<body[\s>]/i)));
  const text = main
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) as string[]);
}

/** true when the rendered DOM (not the server HTML) is the content of a Next.js page (see module doc). */
export function preferRenderedContent(raw: string, rendered: string): boolean {
  // only a Next.js source is rendered from its browser DOM (react mode, @cmp/design); every other site keeps its server
  // HTML and runs its own scripts in the generated app, which render the client-side content there
  if (!/<script[^>]+src=["'][^"']*\/_next\/static\//i.test(raw)) return false;
  if (/data-drupal-|drupal-settings-json|\/sites\/default\/files\//.test(raw)) return false;
  const body = raw.slice(Math.max(0, raw.search(/<body[\s>]/i)));
  if (new Set(body.match(/<[a-z][a-z0-9]*-[a-z0-9-]+(?=[\s>/])/gi) ?? []).size >= 8) return false;
  const a = mainWords(raw), b = mainWords(rendered);
  let added = 0, lost = 0;
  for (const w of b) if (!a.has(w)) added++;
  for (const w of a) if (!b.has(w)) lost++;
  return added >= 5 && lost <= Math.max(2, 0.02 * a.size);
}

/** a usable server HTML capture (a document with a body, not an error stub) */
export const isServerHtml = (raw: string): boolean => /<body[\s>]/i.test(raw) && raw.length > 200;

/**
 * The content HTML of a crawled page: the raw server HTML, unless the rendered DOM is preferred (`preferRenderedContent`)
 * or no usable raw capture exists; `contentSource: "rendered"` forces the rendered DOM.
 * `read` resolves a workspace-relative capture path (missing file → rejects).
 */
export async function pageContentHtml(
  files: { raw?: string; rendered: string },
  read: (rel: string) => Promise<string>,
  contentSource: "raw" | "rendered" = "raw",
): Promise<{ html: string; source: "raw" | "rendered" }> {
  if (contentSource === "raw" && files.raw) {
    try {
      const raw = await read(files.raw);
      if (isServerHtml(raw)) {
        const rendered = await read(files.rendered).catch(() => "");
        if (rendered && preferRenderedContent(raw, rendered)) return { html: rendered, source: "rendered" };
        return { html: raw, source: "raw" };
      }
    } catch {
      /* fall back */
    }
  }
  return { html: await read(files.rendered), source: "rendered" };
}
