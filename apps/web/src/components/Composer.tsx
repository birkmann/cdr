import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Attachment } from "@harness/client";
import { IconFile, IconPlus, IconSend, IconStop, IconX } from "./icons";

export interface PendingFile extends Attachment {
  id: string;
  size: number;
  preview?: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 20;

function readFile(file: File): Promise<PendingFile> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const url = String(r.result);
      const data = url.slice(url.indexOf(",") + 1);
      const mimeType = file.type || "application/octet-stream";
      resolve({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        name:
          file.name || (mimeType.startsWith("image/") ? `pasted-image.${mimeType.split("/")[1]}` : "file"),
        mimeType,
        data,
        size: file.size,
        preview: mimeType.startsWith("image/") ? url : undefined,
      });
    };
    r.readAsDataURL(file);
  });
}

function fmtSize(n: number): string {
  return n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface ComposerProps {
  placeholder?: string;
  draft?: string;
  busy?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  autoFocus?: boolean;
  large?: boolean;
  onSend(text: string, files: PendingFile[]): Promise<boolean | void> | boolean | void;
  onStop?(): void;
  left?: ReactNode;
  right?: ReactNode;
}

export function Composer({
  placeholder,
  draft,
  busy,
  disabled,
  disabledReason,
  autoFocus,
  large,
  onSend,
  onStop,
  left,
  right,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px";
  }, [text]);

  useEffect(() => {
    if (draft !== undefined) {
      setText(draft);
      ta.current?.focus();
    }
  }, [draft]);

  const addFiles = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    const tooBig = arr.find((f) => f.size > MAX_BYTES);
    if (tooBig) return setError(`${tooBig.name} is larger than 10 MB`);
    if (files.length + arr.length > MAX_FILES) return setError(`At most ${MAX_FILES} files`);
    try {
      const read = await Promise.all(arr.map(readFile));
      setFiles((f) => [...f, ...read]);
      setError(undefined);
    } catch (e) {
      setError(String(e));
    }
  };

  const canSend = !disabled && !busy && !sending && (text.trim().length > 0 || files.length > 0);
  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const body = text.trim() || (files.length ? "See the attached files." : "");
      const ok = await onSend(body, files);
      if (ok !== false) {
        setText("");
        setFiles([]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };

  return (
    <div
      className={`composer ${large ? "large" : ""} ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <div className="attachments">
          {files.map((f) => (
            <div
              key={f.id}
              className={`attachment ${f.preview ? "image" : ""}`}
              title={`${f.name} · ${fmtSize(f.size)}`}
            >
              {f.preview ? (
                <img src={f.preview} alt={f.name} />
              ) : (
                <>
                  <IconFile size={18} />
                  <span className="att-name">{f.name}</span>
                  <span className="att-size">{fmtSize(f.size)}</span>
                </>
              )}
              <button
                className="att-remove"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        aria-label="Message CDR"
        disabled={disabled}
        value={text}
        autoFocus={autoFocus}
        rows={large ? 2 : 1}
        placeholder={disabled && disabledReason ? disabledReason : placeholder}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            e.preventDefault();
            void addFiles(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {error && (
        <div className="composer-error">
          {error}{" "}
          <button className="ghost tiny" onClick={() => setError(undefined)}>
            dismiss
          </button>
        </div>
      )}
      <div className="composer-bar">
        <div className="composer-left">
          <button
            type="button"
            className="ghost icon"
            title="Attach files or images"
            onClick={() => picker.current?.click()}
            aria-label="Attach files"
          >
            <IconPlus size={19} />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => (e.target.files && void addFiles(e.target.files), (e.target.value = ""))}
          />
          {left}
        </div>
        <div className="composer-right">
          {right}
          {busy && onStop ? (
            <button type="button" className="send stop" onClick={onStop} title="Stop" aria-label="Stop">
              <IconStop size={15} />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              onClick={() => void submit()}
              disabled={!canSend}
              title="Send (Enter)"
              aria-label="Send"
            >
              <IconSend size={17} />
            </button>
          )}
        </div>
      </div>
      {dragging && <div className="drop-hint">Drop files to attach</div>}
    </div>
  );
}
