import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  gutter,
  GutterMarker,
} from "@codemirror/view";
import { EditorState, StateEffect, StateField, RangeSet, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import type { Diagnostic } from "../ipc";

export function languageFor(path: string): LanguageSupport | Extension | null {
  const name = path.split("/").pop()!.toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
    case "json5":
      return json();
    case "html":
    case "htm":
    case "svelte":
    case "vue":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "md":
    case "markdown":
    case "mdx":
      return markdown();
    case "py":
    case "pyi":
      return python();
    case "rs":
      return rust();
    case "go":
      return go();
    case "java":
    case "kt":
      return java();
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "hpp":
    case "cxx":
      return cpp();
    case "sql":
      return sql();
    case "xml":
    case "svg":
    case "plist":
      return xml();
    case "yml":
    case "yaml":
      return yaml();
    case "toml":
    case "ini":
    case "conf":
    case "env":
      return StreamLanguage.define({
        token(stream) {
          if (stream.match(/^\s*[#;].*/)) return "comment";
          if (stream.match(/^\[[^\]]*\]/)) return "heading";
          if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) return "string";
          if (stream.match(/^-?\d[\d_.eE+-]*/)) return "number";
          if (stream.match(/^(true|false)\b/)) return "atom";
          if (stream.match(/^[\w.-]+(?=\s*=)/)) return "propertyName";
          stream.next();
          return null;
        },
      });
    default:
      return null;
  }
}

export const studioTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--st-selection) !important",
  },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--st-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--st-active-line)", color: "var(--text)" },
  ".cm-searchMatch": { backgroundColor: "var(--st-search-match)", outline: "1px solid var(--warn)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
  ".cm-selectionMatch": { backgroundColor: "var(--st-selection-match)" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--border-strong)" },
  ".cm-panels": { backgroundColor: "var(--bg-elev)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panel input, .cm-panel button": { fontSize: "12px" },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-elev)",
    border: "1px solid var(--border)",
    color: "var(--text)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--text)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--code-bg)",
    border: "1px solid var(--border)",
    color: "var(--muted)",
  },
  ".cm-st-gitgutter": { width: "4px", paddingLeft: "2px" },
});

export const studioHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--hl-kw)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--hl-str)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--hl-num)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--hl-com)",
    fontStyle: "italic",
  },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--hl-fn)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--hl-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--text-2)" },
  { tag: [t.heading], fontWeight: "700", color: "var(--hl-fn)" },
  { tag: [t.link, t.url], color: "var(--hl-fn)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.invalid], color: "var(--bad)" },
]);

// ------------------------------------------------------------------ git change gutter

export type LineChange = { line: number; kind: "added" | "modified" | "deleted" };
class ChangeMarker extends GutterMarker {
  constructor(readonly kind: LineChange["kind"]) {
    super();
  }
  eq(o: ChangeMarker) {
    return o.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `st-git-mark ${this.kind}`;
    return el;
  }
}
export const setLineChanges = StateEffect.define<LineChange[]>();
const changesField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setLineChanges)) {
        const doc = tr.state.doc;
        const marks = e.value
          .filter((c) => c.line >= 1 && c.line <= doc.lines)
          .sort((a, b) => a.line - b.line)
          .map((c) => new ChangeMarker(c.kind).range(doc.line(c.line).from));
        value = RangeSet.of(marks, true);
      }
    return value;
  },
});
const changeGutter = [
  changesField,
  gutter({ class: "cm-st-gitgutter", markers: (v) => v.state.field(changesField) }),
];

export function toCmDiagnostics(state: EditorState, diags: Diagnostic[]): CmDiagnostic[] {
  const doc = state.doc;
  const pos = (line: number, col: number) => {
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    return Math.min(l.from + Math.max(0, col - 1), l.to);
  };
  return diags.map((d) => {
    const from = pos(d.line, d.column);
    const to = Math.max(from, pos(d.endLine, d.endColumn));
    return {
      from,
      to: to === from ? Math.min(from + 1, doc.length) : to,
      severity: d.severity === "hint" ? "info" : d.severity,
      message: d.message,
      source: d.source,
    };
  });
}
export { setDiagnostics };

export function baseExtensions(onSave: () => void, extra: Extension[] = []): Extension[] {
  return [
    lineNumbers(),
    changeGutter,
    foldGutter(),
    lintGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    syntaxHighlighting(studioHighlight),
    studioTheme,
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (onSave(), true) },
      indentWithTab,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
    ...extra,
  ];
}
