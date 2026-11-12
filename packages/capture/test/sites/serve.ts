// Static file server for the fixture sites (tests never touch the network). Used by the capture, measure and
// recreate tests: `const site = await serveSite("acme")` → { url, close }.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export const SITES_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Serve a directory (default: a fixture site by name) on 127.0.0.1 with a random port. */
export async function serveSite(
  nameOrDir: string,
): Promise<{ url: string; root: string; close(): Promise<void> }> {
  const root = existsSync(nameOrDir) ? resolve(nameOrDir) : join(SITES_DIR, nameOrDir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    root,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
