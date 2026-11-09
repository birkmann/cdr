/**
 * Canonical percent-encoding for request paths, so files copied into public/ under their original names are found.
 *
 * Next.js looks public/ files up by their per-segment `encodeURIComponent` form (or the fully decoded form). Original
 * markup often mixes raw sub-delimiters with escapes, e.g. `/dam/jcr:abc/My%20Photo.jpg` (Magnolia, AEM): browsers send
 * that verbatim, it matches neither form and the file 404s. Such paths are rewritten (not redirected) to the
 * canonical form; paths without an escape, and paths that already are canonical, pass through untouched.
 */
import { NextResponse, type NextRequest } from "next/server";

export function canonicalPath(pathname: string): string | undefined {
  if (!pathname.includes("%")) return undefined;
  try {
    const canonical = pathname
      .split("/")
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join("/");
    return canonical === pathname ? undefined : canonical;
  } catch {
    return undefined; // malformed escape: leave it to the router
  }
}

export function proxy(request: NextRequest) {
  const canonical = canonicalPath(request.nextUrl.pathname);
  if (!canonical) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = canonical;
  return NextResponse.rewrite(url);
}

export const config = { matcher: ["/((?!_next/|api/).*)"] };
