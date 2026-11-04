import { useStudio } from "../store";
import { IX } from "./icons";

export function Toasts() {
  const { toasts, dismiss } = useStudio();
  return (
    <div className="st-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`st-toast ${t.kind}`}>
          <span>{t.text}</span>
          <button className="ghost tiny" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <IX size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
