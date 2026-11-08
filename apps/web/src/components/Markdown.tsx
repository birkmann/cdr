import { createContext, memo, useContext, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import { IconCheck, IconCode } from "./icons";

export function highlight(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang))
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    if (code.length < 20_000) return hljs.highlightAuto(code).value;
  } catch {
    /* fall through */
  }
  return code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  html: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "makefile",
  lua: "lua",
};

export function langForPath(path: string): string | undefined {
  const name = path.split("/").pop()!.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return EXT_LANG[name.split(".").pop() ?? ""];
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>
          <IconCode size={13} /> {lang || "text"}
        </span>
        <button
          className="ghost tiny"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? (
            <>
              <IconCheck size={13} /> Copied
            </>
          ) : (
            "Copy"
          )}
        </button>
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlight(code, lang) }} />
      </pre>
    </div>
  );
}

/** Lets a host app turn references to project files in messages into links. */
export interface FileLinks {
  /** The project file a reference names; undefined when there is no such file. */
  resolve(ref: string): { path: string; line?: number } | undefined;
  open(path: string, line?: number): void;
  icon?(path: string): ReactNode;
}
export const FileLinksContext = createContext<FileLinks | null>(null);

/** A reference shown as a link when it names a project file; otherwise `fallback`. */
export function FileLink({
  reference,
  children,
  fallback,
}: {
  reference: string;
  children: ReactNode;
  fallback: ReactNode;
}) {
  const links = useContext(FileLinksContext);
  const target = links?.resolve(reference);
  if (!links || !target) return <>{fallback}</>;
  return (
    <button
      type="button"
      className="file-link"
      title={target.line ? `${target.path}:${target.line}` : target.path}
      onClick={(e) => {
        e.stopPropagation();
        links.open(target.path, target.line);
      }}
    >
      {links.icon?.(target.path)}
      <span>{children}</span>
    </button>
  );
}

const isFileHref = (href: string) => href.startsWith("file:") || !/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href);

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
            const code = String(children ?? "");
            if (!lang && !code.includes("\n")) {
              const inline = <code className="inline">{children}</code>;
              return (
                <FileLink reference={code} fallback={inline}>
                  {code}
                </FileLink>
              );
            }
            return <CodeBlock code={code.replace(/\n$/, "")} lang={lang} />;
          },
          pre({ children }) {
            return <>{children}</>;
          },
          a({ href, children }) {
            const link = (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
            if (!href || !isFileHref(href)) return link;
            return (
              <FileLink reference={href.replace(/^file:\/\//, "")} fallback={link}>
                {children}
              </FileLink>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
