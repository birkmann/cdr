/** Sanitised raw HTML (CCM rawHtml nodes, html fields) rendered as real elements — no wrapper, so original CSS applies. */
import { nodesToReact } from "../html/react";
import { sanitizeHtml } from "../html/sanitize";

export function RawHtml({ html }: { html: string }) {
  return <>{nodesToReact(sanitizeHtml(html))}</>;
}
