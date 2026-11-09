/**
 * On-demand revalidation for Contentful webhooks (publish/unpublish of entries & assets).
 * Secret via `x-revalidate-secret` header (or ?secret=). Revalidates the entry's paths, or everything if unknown.
 */
import { revalidatePath } from "next/cache";
import { getConfig } from "../../../lib/config";
import { invalidateData } from "../../../lib/data";

export async function POST(request: Request) {
  const secret = request.headers.get("x-revalidate-secret") ?? new URL(request.url).searchParams.get("secret");
  const expected = getConfig().revalidateSecret;
  if (!expected || secret !== expected) return Response.json({ revalidated: false, error: "invalid secret" }, { status: 401 });
  let body: { sys?: { type?: string; contentType?: { sys?: { id?: string } } }; fields?: { path?: Record<string, string> } } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body → full revalidation */
  }
  invalidateData();
  const paths = Object.values(body.fields?.path ?? {}).filter((p): p is string => typeof p === "string" && p.startsWith("/"));
  const docLevel = body.sys?.type === "Entry" && paths.length > 0;
  if (docLevel) for (const p of paths) revalidatePath(p);
  // components, navigation, settings, assets affect many pages → revalidate the whole layout tree
  else revalidatePath("/", "layout");
  return Response.json({ revalidated: true, paths: docLevel ? paths : ["/ (layout)"], now: Date.now() });
}
