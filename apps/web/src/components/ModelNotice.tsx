import { useEffect, useState } from "react";
import { useApp } from "../app-state";

/**
 * Says up front when the chosen model's provider has no API key (or no model is set),
 * so nobody sends a prompt that can only fail. The server enforces the same check.
 */
export function ModelNotice({
  model,
  projectPath,
  onConnect,
}: {
  /** Explicitly chosen model ref; empty = the project's configured executor. */
  model?: string;
  projectPath?: string;
  /** Opens the place where keys are entered (desktop settings). Without it, the notice names ~/.harness/.env. */
  onConnect?(): void;
}) {
  const { client } = useApp();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    let live = true;
    setProblem(undefined);
    if (!client) return;
    const check = () =>
      void client
        .models(projectPath)
        .then((r) => {
          if (!live) return;
          const ref = model || r.models.find((m) => m.role === "executor")?.id || "";
          const provider = ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : "";
          if (!ref) return setProblem("No model is connected. Choose a model to start.");
          const p = r.providers.find((x) => x.id === provider);
          if (!p) return setProblem(`No model is connected: provider “${provider}” is not set up.`);
          setProblem(p.configured ? undefined : `No model is connected: ${ref} needs a ${provider} API key.`);
        })
        .catch(() => {});
    check();
    // keys added in settings restart the harness; re-check when the window regains focus
    window.addEventListener("focus", check);
    return () => {
      live = false;
      window.removeEventListener("focus", check);
    };
  }, [client, model, projectPath]);
  if (!problem) return null;
  return (
    <div className="model-notice" role="alert">
      <span>
        {problem}{" "}
        {onConnect
          ? "Add a key in Settings → Model providers, or pick a model from a connected provider."
          : "Add the key to ~/.harness/.env (or the project .env) and restart CDR, or pick a model from a connected provider."}
      </span>
      {onConnect && (
        <button className="tiny" onClick={onConnect}>
          Connect a model
        </button>
      )}
    </div>
  );
}
