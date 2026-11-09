/** Parsed HTML tree → React elements (no wrapper element, attributes mapped to React props). */
import { createElement, Fragment, type ReactNode } from "react";
import { BOOLEAN_ATTRS, reactAttrName, styleToObject, type HNode } from "./parse";

export function attrsToProps(attrs: [string, string | null][]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [k, v] of attrs) {
    const lower = k.toLowerCase();
    if (lower.startsWith("on") || lower.startsWith("{{")) continue;
    const name = reactAttrName(k);
    if (lower === "style") props.style = styleToObject(v ?? "");
    else if (BOOLEAN_ATTRS.has(lower)) props[name] = v === null || v === "" || v === lower ? true : v;
    else props[name] = v ?? "";
  }
  return props;
}

export function nodesToReact(nodes: HNode[], keyPrefix = "h"): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    if (n.type === "text") return <Fragment key={key}>{n.value}</Fragment>;
    if (n.type === "comment") return null;
    const props = attrsToProps(n.attrs);
    props.key = key;
    if (n.name === "script" || n.name === "style") {
      const body = n.children.map((c) => (c.type === "text" ? c.value : "")).join("");
      return createElement(n.name, { ...props, dangerouslySetInnerHTML: { __html: body } });
    }
    // the source's form controls render uncontrolled (their initial value/state, editable)
    if (n.name === "input" || n.name === "textarea" || n.name === "select") {
      if ("value" in props) {
        props.defaultValue = props.value;
        delete props.value;
      }
      if ("checked" in props) {
        props.defaultChecked = props.checked;
        delete props.checked;
      }
      if (n.name === "textarea") {
        const text = n.children.map((c) => (c.type === "text" ? c.value : "")).join("");
        return createElement("textarea", { ...props, ...(text && !("defaultValue" in props) ? { defaultValue: text } : {}) });
      }
    }
    const kids = nodesToReact(n.children, key + ".");
    // SVG keeps its camelCase names (linearGradient, clipPath, foreignObject): the parser preserves them in rawName
    return createElement(n.rawName.includes(":") || n.rawName !== n.name ? n.rawName : n.name, props, ...(kids.length ? kids : []));
  });
}
