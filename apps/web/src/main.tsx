import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp } from "./app-state";
import { Sidebar } from "./components/Sidebar";
import { Home } from "./components/Home";
import { ColumnResize, useColumnWidth } from "./components/ColumnResize";
import type { CSSProperties } from "react";

import { ConnectScreen, SettingsDialog } from "./components/Settings";

import { CommandPalette } from "./components/CommandPalette";
import { IconMenu } from "./components/icons";
import "./styles.css";

const ChatView = lazy(() => import("./components/ChatView").then((m) => ({ default: m.ChatView })));
const Library = lazy(() => import("./components/Library").then((m) => ({ default: m.Library })));

function Shell() {
  const { route, connection, client, navigate } = useApp();
  const [settings, setSettings] = useState(false);
  const [nav, setNav] = useState(false);
  const [search, setSearch] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [homeVersion, setHomeVersion] = useState(0);
  const sidebar = useColumnWidth("morrow.sidebar-width", {
    initial: () => 258,
    min: 200,
    max: (available) => Math.min(400, available - 480),
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((v) => !v);
      }
      if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
      if (e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        navigate({ name: "home" });
        setHomeVersion((v) => v + 1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [navigate]);
  useEffect(() => {
    document.title =
      route.name === "home"
        ? "CDR — Code. Build. Ship."
        : `CDR · ${route.name === "chat" ? "Conversation" : route.name === "artifacts" ? "Creations" : route.name}`;
  }, [route]);
  if (!client || connection === "unauthorized" || (connection === "offline" && !client))
    return <ConnectScreen />;
  return (
    <div
      ref={sidebar.ref}
      style={{ "--sidebar-width": `${sidebar.width}px` } as CSSProperties}
      className={`app ${nav ? "nav-open" : ""} ${collapsed ? "nav-collapsed" : ""}`}
    >
      <Sidebar
        onSettings={() => setSettings(true)}
        onNavigate={() => {
          setNav(false);
          setHomeVersion((v) => v + 1);
        }}
        onSearch={() => setSearch(true)}
        onToggle={() => {
          setCollapsed((v) => !v);
          setNav(false);
        }}
      />
      {!collapsed && <ColumnResize label="Resize sidebar" className="sidebar-resize" size={sidebar} />}
      <div className="scrim" onClick={() => setNav(false)} />
      <main className="main">
        <button
          className="ghost icon menu-btn"
          onClick={() => {
            setNav(true);
            setCollapsed(false);
          }}
          aria-label="Open menu"
        >
          <IconMenu />
        </button>
        {connection === "offline" && (
          <div className="banner">Lost connection to the CDR server – retrying…</div>
        )}
        <Suspense
          fallback={
            <div className="workspace-loading" role="status">
              <span className="spinner" /> Opening workspace…
            </div>
          }
        >
          {route.name === "home" ? (
            <Home key={`${route.projectPath || ""}:${homeVersion}`} projectPath={route.projectPath} />
          ) : route.name === "chat" ? (
            <ChatView key={route.id} id={route.id} initialPreview={route.preview} />
          ) : (
            <Library key={route.name} kind={route.name} />
          )}
        </Suspense>
      </main>
      {search && <CommandPalette onClose={() => setSearch(false)} onSettings={() => setSettings(true)} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <Shell />
    </AppProvider>
  </StrictMode>,
);
