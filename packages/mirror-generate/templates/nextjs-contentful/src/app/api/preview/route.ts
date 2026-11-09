/** Contentful preview URL: /api/preview?secret=…&path=/de/ueber-uns → enables draft mode, redirects to the page. */
import { draftMode } from "next/headers";
import { redirect } from "next/navigation";
import { getConfig } from "../../../lib/config";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  const path = url.searchParams.get("path") ?? url.searchParams.get("slug") ?? "/";
  const expected = getConfig().previewSecret;
  if (!expected || secret !== expected) return new Response("Invalid preview secret", { status: 401 });
  if (!path.startsWith("/") || path.startsWith("//")) return new Response("Invalid path", { status: 400 });
  (await draftMode()).enable();
  redirect(path);
}
