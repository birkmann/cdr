/** Runs before page scripts. Opaque-origin previews cannot access browser storage. */
function installPreviewStorage() {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      void window[name];
      continue;
    } catch {
      // Keep the iframe isolated; use document-local memory instead of the app's storage.
    }
    const values = new Map<string, string>();
    const api = {
      get length() {
        return values.size;
      },
      key(index: number) {
        return [...values.keys()][Number(index) >>> 0] ?? null;
      },
      getItem(key: string) {
        return values.get(String(key)) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(String(key), String(value));
      },
      removeItem(key: string) {
        values.delete(String(key));
      },
      clear() {
        values.clear();
      },
    };
    const storage = new Proxy(Object.create(null), {
      get(_target, key) {
        if (key === Symbol.toStringTag) return "Storage";
        if (Object.prototype.hasOwnProperty.call(api, key)) return Reflect.get(api, key);
        return typeof key === "string" ? values.get(key) : undefined;
      },
      set(_target, key, value) {
        if (typeof key === "string") values.set(key, String(value));
        return true;
      },
      deleteProperty(_target, key) {
        if (typeof key === "string") values.delete(key);
        return true;
      },
      ownKeys: () => [...values.keys()],
      has: (_target, key) => key in api || (typeof key === "string" && values.has(key)),
      getOwnPropertyDescriptor(_target, key) {
        if (typeof key === "string" && values.has(key))
          return { configurable: true, enumerable: true, writable: true, value: values.get(key) };
      },
    });
    Object.defineProperty(window, name, { configurable: true, value: storage });
  }
}

/** Serve compatibility code without modifying generated files or relaxing the sandbox. */
export function preparePreviewHtml(html: string): string {
  // Preserve the doctype (including leading comments), so standards mode stays intact.
  const prefix = html.match(/^(?:\uFEFF)?(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i)?.[0] ?? "";
  const bootstrap = `<script data-cdr-preview>(${installPreviewStorage.toString()})();</script>`;
  return prefix + bootstrap + html.slice(prefix.length);
}
