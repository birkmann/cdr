import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Attachment, AttachmentInfo, ImagePart } from "@harness/protocol";

export const ATTACHMENT_LIMITS = { maxFiles: 20, maxBytes: 10 * 1024 * 1024, maxInlineText: 100_000 };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXT = new Set(
  ".txt .md .markdown .json .jsonc .yaml .yml .toml .ini .cfg .conf .env.example .csv .tsv .xml .html .htm .css .scss .less .js .jsx .mjs .cjs .ts .tsx .py .rb .go .rs .java .kt .kts .swift .c .h .cc .cpp .hpp .cs .php .sh .bash .zsh .fish .ps1 .sql .graphql .proto .vue .svelte .lua .r .dart .scala .ex .exs .erl .hs .ml .tf .gradle .dockerfile .log .diff .patch".split(
    " ",
  ),
);

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
}

function looksLikeText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

export interface ProcessedAttachments {
  /** Text to append to the user's message (inlined text files, paths of other files). */
  text: string;
  images: ImagePart[];
  infos: AttachmentInfo[];
}

/**
 * Save attachments under <project>/.harness/attachments/<sessionId>/ and turn them into model input:
 * images are passed to the model, text files are inlined, other files are referenced by path.
 */
export function processAttachments(
  projectRoot: string,
  sessionId: string,
  attachments: Attachment[] = [],
): ProcessedAttachments {
  if (!attachments.length) return { text: "", images: [], infos: [] };
  if (attachments.length > ATTACHMENT_LIMITS.maxFiles)
    throw new Error(`Too many attachments (max ${ATTACHMENT_LIMITS.maxFiles})`);
  const relDir = `.harness/attachments/${sessionId}`;
  const dir = join(projectRoot, relDir);
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  const images: ImagePart[] = [];
  const infos: AttachmentInfo[] = [];
  const blocks: string[] = [];
  attachments.forEach((a, i) => {
    if (typeof a?.data !== "string" || typeof a?.name !== "string") throw new Error("Invalid attachment");
    const buf = Buffer.from(a.data, "base64");
    if (buf.length > ATTACHMENT_LIMITS.maxBytes) throw new Error(`Attachment ${a.name} is larger than 10 MB`);
    const name = `${stamp}-${i + 1}-${safeName(a.name)}`;
    writeFileSync(join(dir, name), buf);
    const path = `${relDir}/${name}`;
    const mime = (a.mimeType || "application/octet-stream").toLowerCase();
    const ext = extname(a.name).toLowerCase();
    let kind: AttachmentInfo["kind"];
    if (IMAGE_TYPES.has(mime)) {
      kind = "image";
      images.push({ mimeType: mime, data: buf.toString("base64"), name: a.name });
      blocks.push(`- Image \`${a.name}\` (saved at \`${path}\`) is attached to this message.`);
    } else if (
      mime.startsWith("text/") ||
      TEXT_EXT.has(ext) ||
      /json|xml|javascript|typescript|yaml|toml|x-sh/.test(mime) ||
      (!mime.startsWith("image/") && looksLikeText(buf) && buf.length < ATTACHMENT_LIMITS.maxInlineText)
    ) {
      kind = "text";
      const text = buf.toString("utf8");
      if (text.length <= ATTACHMENT_LIMITS.maxInlineText) {
        const fence = text.includes("```") ? "````" : "```";
        blocks.push(
          `- File \`${a.name}\` (saved at \`${path}\`):\n${fence}${ext.slice(1)}\n${text}\n${fence}`,
        );
      } else
        blocks.push(
          `- File \`${a.name}\` is large (${buf.length} bytes); it is saved at \`${path}\` – read it with tools.`,
        );
    } else {
      kind = "binary";
      blocks.push(`- File \`${a.name}\` (${mime}, ${buf.length} bytes) is saved at \`${path}\`.`);
    }
    infos.push({ name: a.name, mimeType: mime, size: buf.length, path, kind });
  });
  return { text: `\n\n## Attachments\n${blocks.join("\n")}`, images, infos };
}
