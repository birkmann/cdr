import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CodeBlock } from "@web/components/Markdown";
import { useStudio } from "../store";
import { fs } from "../ipc";
import { resolveRelative } from "../markdown-path";

// READMEs lean on raw HTML (centered headings, <img width>, <details>); keep the
// GitHub-style subset that is safe to render and nothing that runs script.
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "align"],
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height"],
  },
};

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

/** Rendered view of a Markdown file in the workspace, using the editor buffer (so unsaved edits show). */
export function MarkdownPreview({ path }: { path: string }) {
  const st = useStudio();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    st.loadBuffer(path).then(
      (b) => !cancelled && setText(b.content),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Pick up changes that landed in the buffer after mount (e.g. reloaded from disk).
  const current = st.buffers.get(path)?.content ?? text;

  if (error) return <div className="st-empty">{error}</div>;
  if (current === null) return <div className="st-empty">Loading…</div>;

  return (
    <div className="st-scroll-page">
      <article className="md st-md-preview">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
          components={{
            code({ className, children }) {
              const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
              const code = String(children ?? "");
              if (!lang && !code.includes("\n")) return <code className="inline">{children}</code>;
              return <CodeBlock code={code.replace(/\n$/, "")} lang={lang} />;
            },
            pre({ children }) {
              return <>{children}</>;
            },
            a({ href, children }) {
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    if (!href) return;
                    if (href.startsWith("#")) {
                      // rehype-sanitize prefixes heading ids with "user-content-".
                      const id = decodeURIComponent(href.slice(1));
                      const el = document.getElementById(`user-content-${id}`) ?? document.getElementById(id);
                      el?.scrollIntoView({ block: "start" });
                    } else if (isExternal(href)) {
                      if (/^(https?|mailto):/i.test(href)) void openUrl(href);
                    } else {
                      const target = resolveRelative(path, href.split("#")[0]!);
                      if (target && !target.endsWith("/")) st.openTab({ kind: "file", path: target });
                    }
                  }}
                >
                  {children}
                </a>
              );
            },
            img({ src, alt, width, height }) {
              return <WorkspaceImage base={path} src={src} alt={alt} width={width} height={height} />;
            },
          }}
        >
          {current}
        </ReactMarkdown>
      </article>
    </div>
  );
}

function WorkspaceImage({
  base,
  src,
  alt,
  width,
  height,
}: {
  base: string;
  src?: string;
  alt?: string;
  width?: number | string;
  height?: number | string;
}) {
  const st = useStudio();
  const root = st.workspace?.root;
  const local = !!src && !isExternal(src) && !src.startsWith("data:");
  const [url, setUrl] = useState<string | undefined>(local ? undefined : src);

  useEffect(() => {
    if (!local || !root || !src) return;
    const target = resolveRelative(base, src.split(/[?#]/)[0]!);
    if (!target) return;
    let cancelled = false;
    fs.readImage(root, target).then(
      (u) => !cancelled && setUrl(u),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [base, src, root, local]);

  if (!url) return <span className="st-md-img-missing">{alt || src}</span>;
  return <img src={url} alt={alt} width={width} height={height} />;
}
