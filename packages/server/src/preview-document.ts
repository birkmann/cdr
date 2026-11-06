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

/**
 * Runs in a preview opened in a browser tab: polls the version of the page's folder and reloads once a change
 * has settled (two equal polls in a row, so a burst of agent writes reloads once), keeping the scroll position.
 */
function installLiveReload(versionUrl: string) {
  const key = `cdr-live-scroll:${location.pathname}`;
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) {
      sessionStorage.removeItem(key);
      const [x, y] = saved.split(",").map(Number);
      addEventListener("load", () => setTimeout(() => scrollTo(x, y), 0));
    }
  } catch {
    // storage unavailable: reload at the top
  }
  let current: string | undefined;
  let seen: string | undefined;
  const tick = async () => {
    try {
      const r = await fetch(versionUrl, { cache: "no-store" });
      if (r.ok) {
        const { version } = (await r.json()) as { version: string };
        if (current === undefined) current = version;
        else if (version !== current && version === seen) {
          try {
            sessionStorage.setItem(key, `${scrollX},${scrollY}`);
          } catch {
            // storage unavailable
          }
          location.reload();
          return;
        }
        seen = version;
      }
    } catch {
      // server restarting: keep polling
    }
    setTimeout(tick, 600);
  };
  void tick();
}

/** Name of the virtual file in a preview folder that reports that folder's version (for live reload). */
export const LIVE_VERSION_FILE = ".cdr-live";

/**
 * Serve compatibility code without modifying generated files or relaxing the sandbox.
 * `live` adds live reload for previews opened in a browser tab (not the app's own preview, which refreshes itself).
 */
export function preparePreviewHtml(html: string, options: { live?: boolean } = {}): string {
  // Preserve the doctype (including leading comments), so standards mode stays intact.
  const prefix = html.match(/^(?:\uFEFF)?(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i)?.[0] ?? "";
  let bootstrap = `<script data-cdr-preview>(${installPreviewStorage.toString()})();</script>`;
  if (options.live)
    bootstrap += `<script data-cdr-live>(${installLiveReload.toString()})(${JSON.stringify(LIVE_VERSION_FILE)});</script>`;
  return prefix + bootstrap + html.slice(prefix.length);
}
