import { useStudio, type Toast } from "../store";
import { ICheck, IWarn, IX } from "./icons";

const ICONS: Record<Toast["kind"], React.ReactNode> = {
  success: <ICheck size={15} />,
  error: <IWarn size={15} />,
  info: (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  ),
};

export function Toasts() {
  const { toasts, dismiss, holdToast } = useStudio();
  if (!toasts.length) return null;
  return (
    <div className="st-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`st-toast ${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
          onMouseEnter={() => holdToast(t.id, true)}
          onMouseLeave={() => holdToast(t.id, false)}
        >
          <span className="st-toast-icon">{ICONS[t.kind]}</span>
          <span className="st-toast-text">{t.text}</span>
          {t.count > 1 && (
            <span key={t.count} className="st-toast-count" aria-label={`${t.count} times`}>
              ×{t.count}
            </span>
          )}
          <button
            className="ghost icon tiny st-toast-close"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            <IX size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
