import { memo, useState } from "react";
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

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
