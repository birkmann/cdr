// Minimal LSP document sync: the Rust side starts servers and performs the initialize handshake;
// the editor reports open/change/save/close so servers publish diagnostics.
import { lsp } from "../ipc";

const LANGS: Record<string, { server: string; languageId: string }> = {
  ts: { server: "typescript", languageId: "typescript" },
  mts: { server: "typescript", languageId: "typescript" },
  cts: { server: "typescript", languageId: "typescript" },
  tsx: { server: "typescript", languageId: "typescriptreact" },
  js: { server: "typescript", languageId: "javascript" },
  mjs: { server: "typescript", languageId: "javascript" },
  cjs: { server: "typescript", languageId: "javascript" },
  jsx: { server: "typescript", languageId: "javascriptreact" },
  rs: { server: "rust", languageId: "rust" },
  py: { server: "python", languageId: "python" },
  go: { server: "go", languageId: "go" },
};

export function lspLanguage(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGS[ext];
}

const servers = new Map<string, Promise<number | null>>();
const versions = new Map<string, number>();

function uri(root: string, path: string) {
  return "file://" + encodeURI(`${root}/${path}`).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

async function server(root: string, language: string): Promise<number | null> {
  const key = `${root}\0${language}`;
  let p = servers.get(key);
  if (!p) {
    p = lsp.start(root, language).catch(() => null);
    servers.set(key, p);
  }
  return p;
}

export function resetServers(root: string) {
  for (const k of [...servers.keys()]) if (k.startsWith(root + "\0")) servers.delete(k);
}

export async function didOpen(root: string, path: string, text: string) {
  const l = lspLanguage(path);
  if (!l) return;
  const id = await server(root, l.server);
  if (id == null) return;
  versions.set(`${root}/${path}`, 1);
  await lsp
    .send(id, {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: uri(root, path), languageId: l.languageId, version: 1, text } },
    })
    .catch(() => {});
}

export async function didChange(root: string, path: string, text: string) {
  const l = lspLanguage(path);
  if (!l) return;
  const id = await server(root, l.server);
  if (id == null) return;
  const k = `${root}/${path}`;
  const version = (versions.get(k) ?? 1) + 1;
  versions.set(k, version);
  await lsp
    .send(id, {
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri: uri(root, path), version }, contentChanges: [{ text }] },
    })
    .catch(() => {});
}

export async function didSave(root: string, path: string, text: string) {
  const l = lspLanguage(path);
  if (!l) return;
  const id = await server(root, l.server);
  if (id == null) return;
  await lsp
    .send(id, {
      jsonrpc: "2.0",
      method: "textDocument/didSave",
      params: { textDocument: { uri: uri(root, path) }, text },
    })
    .catch(() => {});
}

export async function didClose(root: string, path: string) {
  const l = lspLanguage(path);
  if (!l) return;
  const id = await server(root, l.server);
  if (id == null) return;
  versions.delete(`${root}/${path}`);
  await lsp
    .send(id, {
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri: uri(root, path) } },
    })
    .catch(() => {});
}
