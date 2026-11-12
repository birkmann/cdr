// The modern emitter's own HTML as a tree (it writes well-formed markup: quoted attributes, escaped text, void elements
// unclosed), so the React and Angular emitters can write it in their template syntax.

export type HNode =
  | { type: "el"; tag: string; attrs: [string, string | null][]; children: HNode[] }
  | { type: "text"; text: string }
  | { type: "comment"; text: string };

export const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** Parse markup into nodes (text and attribute values decoded). */
export function parseHtml(html: string): HNode[] {
  const root: HNode & { type: "el" } = { type: "el", tag: "#root", attrs: [], children: [] };
  const stack: (HNode & { type: "el" })[] = [root];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      top().children.push({ type: "comment", text: html.slice(i + 4, end < 0 ? html.length : end) });
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i] === "<" && html[i + 1] === "/") {
      const end = html.indexOf(">", i);
      const tag = html
        .slice(i + 2, end)
        .trim()
        .toLowerCase();
      // close up to the matching element
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k]!.tag.toLowerCase() === tag) {
          stack.length = k;
          break;
        }
      i = end + 1;
      continue;
    }
    if (html[i] === "<" && /[a-zA-Z!]/.test(html[i + 1] ?? "")) {
      if (html[i + 1] === "!") {
        i = html.indexOf(">", i) + 1;
        continue;
      }
      const m = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i))!;
      const tag = m[1]!;
      let j = i + m[0].length;
      const attrs: [string, string | null][] = [];
      for (;;) {
        while (/\s/.test(html[j] ?? "")) j++;
        if (html[j] === ">" || html[j] === undefined) {
          j++;
          break;
        }
        if (html[j] === "/" && html[j + 1] === ">") {
          j += 2;
          break;
        }
        const nm = /^[^\s=>/]+/.exec(html.slice(j))!;
        const name = nm[0];
        j += name.length;
        if (html[j] === "=") {
          j++;
          const q = html[j];
          if (q === '"' || q === "'") {
            const end = html.indexOf(q, j + 1);
            attrs.push([name, decode(html.slice(j + 1, end))]);
            j = end + 1;
          } else {
            const v = /^[^\s>]+/.exec(html.slice(j))![0];
            attrs.push([name, decode(v)]);
            j += v.length;
          }
        } else attrs.push([name, null]);
      }
      const el: HNode & { type: "el" } = { type: "el", tag, attrs, children: [] };
      top().children.push(el);
      if (!VOID_TAGS.has(tag.toLowerCase()) && !html.slice(i, j).endsWith("/>")) stack.push(el);
      i = j;
      continue;
    }
    const next = html.indexOf("<", i + 1);
    const end = next < 0 ? html.length : next;
    top().children.push({ type: "text", text: decode(html.slice(i, end)) });
    i = end;
  }
  return root.children;
}
