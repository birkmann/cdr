import { createServer } from "node:http";

const routes = {
  "GET /health": () => ({ status: 200, body: { ok: true } }),
  "GET /users": () => ({ status: 200, body: [{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }] }),
};

export function handle(method, url) {
  const route = routes[`${method} ${new URL(url, "http://x").pathname}`];
  if (!route) return { status: 404, body: { error: "not found" } };
  return route();
}

export function createApp() {
  return createServer((req, res) => {
    const { status, body } = handle(req.method, req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
}
