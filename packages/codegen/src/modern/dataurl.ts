/** `data:` URL → its media type and bytes (base64 or percent-encoded). */
export function decodeDataUrl(u: string): { mime: string; body: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(u);
  if (!m) return null;
  const mime = (m[1] || "text/plain").toLowerCase();
  const b64 = /;base64/i.test(m[2] ?? "");
  try {
    const body = b64 ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!), "utf8");
    return { mime, body: new Uint8Array(body) };
  } catch {
    return null;
  }
}
