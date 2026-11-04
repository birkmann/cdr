import type { Tool, ToolContext, ToolResult } from "./types.js";
import { registerSecret } from "../util.js";

export const UNSPLASH_SECRET_ENV = ["UNSPLASH_ACCESS_KEY", "UNSPLASH_SECRET_KEY"];
const API = "https://api.unsplash.com";
const USAGE =
  "Use the returned image_url directly (preserve its query parameters). Before embedding a selected photo, call use_unsplash_photo with its download_location. Add visible credit linking the photographer and Unsplash using the returned attribution links. Never put API keys in generated files.";

/** Fixed API origin, no redirects or raw error bodies: credentials stay on the server. */
async function request(url: URL, ctx: ToolContext): Promise<any> {
  const key = process.env.UNSPLASH_ACCESS_KEY?.trim();
  for (const name of UNSPLASH_SECRET_ENV) registerSecret(process.env[name]);
  if (!key)
    throw new Error(
      "Unsplash is not configured. Set UNSPLASH_ACCESS_KEY in the project .env or ~/.harness/.env and restart CDR. UNSPLASH_SECRET_KEY is not needed for photo search.",
    );
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      const hint =
        response.status === 401
          ? "Check UNSPLASH_ACCESS_KEY and restart CDR."
          : response.status === 403 || response.status === 429
            ? "Access was denied or the Unsplash rate limit was reached; retry later."
            : "Retry later or choose another photo.";
      throw new Error(`Unsplash HTTP ${response.status}. ${hint}`);
    }
    return await response.json();
  } catch (error) {
    if (ctx.signal.aborted) throw new Error("Unsplash request cancelled.");
    if (signal.aborted) throw new Error("Unsplash request timed out after 15 seconds.");
    if (error instanceof Error && error.message.startsWith("Unsplash HTTP")) throw error;
    throw new Error("Unsplash request failed. Check your network connection and try again.");
  }
}

function publicUrl(value: unknown, host: string): string {
  if (typeof value !== "string") throw new Error("Unsplash returned an invalid photo URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== host || url.port || url.username || url.password)
    throw new Error("Unsplash returned an invalid photo URL.");
  return url.href;
}

function creditUrl(value: unknown): string {
  const url = new URL(publicUrl(value, "unsplash.com"));
  url.searchParams.set("utm_source", "cdr");
  url.searchParams.set("utm_medium", "referral");
  return url.href;
}

function downloadUrl(value: unknown): URL {
  const url = new URL(publicUrl(value, "api.unsplash.com"));
  if (!/^\/photos\/[A-Za-z0-9_-]+\/download$/.test(url.pathname))
    throw new Error("Use the download_location returned by search_unsplash.");
  for (const key of url.searchParams.keys()) {
    if (key !== "ixid") throw new Error("Unexpected parameter in Unsplash download_location.");
  }
  url.hash = "";
  return url;
}

function failure(error: unknown): ToolResult {
  return { ok: false, output: error instanceof Error ? error.message : "Unsplash request failed." };
}

export const searchUnsplashTool: Tool = {
  name: "search_unsplash",
  description:
    "Search Unsplash for real photography when building pages. Returns hotlinked image URLs, dimensions, alt text, photographer credits and download_location. " +
    USAGE,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Describe the subject or mood of the photo." },
      orientation: { type: "string", enum: ["landscape", "portrait", "squarish"] },
      count: { type: "integer", minimum: 1, maximum: 10, description: "Results (default 5)." },
    },
    required: ["query"],
  },
  readOnly: true,
  async execute(args: { query: string; orientation?: string; count?: number }, ctx) {
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 300)
      return { ok: false, output: "Provide a photo search query of 1–300 characters." };
    if (args.orientation && !["landscape", "portrait", "squarish"].includes(args.orientation))
      return { ok: false, output: "Orientation must be landscape, portrait, or squarish." };
    const count = args.count ?? 5;
    if (!Number.isInteger(count) || count < 1 || count > 10)
      return { ok: false, output: "Count must be an integer from 1 to 10." };
    try {
      const url = new URL("/search/photos", API);
      url.searchParams.set("query", args.query.trim());
      url.searchParams.set("per_page", String(count));
      url.searchParams.set("content_filter", "high");
      if (args.orientation) url.searchParams.set("orientation", args.orientation);
      const data = await request(url, ctx);
      if (!Array.isArray(data.results)) throw new Error("Unsplash returned invalid search results.");
      const photos = data.results.slice(0, count).map((photo: any) => ({
        id: photo.id,
        image_url: publicUrl(photo.urls?.regular, "images.unsplash.com"),
        thumbnail_url: publicUrl(photo.urls?.small, "images.unsplash.com"),
        width: photo.width,
        height: photo.height,
        alt: photo.alt_description ?? photo.description ?? args.query,
        attribution: {
          photographer: photo.user?.name,
          photographer_url: creditUrl(photo.user?.links?.html),
          photo_url: creditUrl(photo.links?.html),
          unsplash_url: creditUrl("https://unsplash.com"),
        },
        download_location: downloadUrl(photo.links?.download_location).href,
      }));
      return { ok: true, output: JSON.stringify({ photos, instructions: USAGE }) };
    } catch (error) {
      return failure(error);
    }
  },
};

export const useUnsplashPhotoTool: Tool = {
  name: "use_unsplash_photo",
  description:
    "Record selection of an Unsplash photo before embedding it in a page. Call once per selected photo, not for every search result. Pass download_location from search_unsplash. This records usage; it does not download or save the image. Keep using image_url and visible photographer/Unsplash credits from the search result.",
  parameters: {
    type: "object",
    properties: { download_location: { type: "string" } },
    required: ["download_location"],
  },
  readOnly: false,
  risk: () => "low",
  async execute(args: { download_location: string }, ctx) {
    try {
      await request(downloadUrl(args.download_location), ctx);
      return {
        ok: true,
        output:
          "Photo selection recorded. Embed the search result's image_url with visible photographer and Unsplash credits.",
      };
    } catch (error) {
      return failure(error);
    }
  },
};
