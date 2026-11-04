// Apply the saved theme before first paint (same storage key as the web app).
try {
  const s = JSON.parse(localStorage.getItem("harness.settings.v1") || "{}");
  const t = s.theme || "dark";
  document.documentElement.dataset.theme =
    t === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t;
} catch {}
