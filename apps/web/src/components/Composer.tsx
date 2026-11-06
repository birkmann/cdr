import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Attachment, SkillInfo } from "@harness/client";
import { useApp } from "../app-state";
import { findUrl, parseRecreateCommand } from "../recreate";
import { Popover } from "./Pickers";
import { IconCopy, IconFile, IconPlus, IconSend, IconSparkle, IconStop, IconX } from "./icons";

/** Skills selectable for a message in a project ("" = a new sandbox: built-in and user skills only). */
export function useSkills(projectPath: string | undefined): SkillInfo[] {
  const { client } = useApp();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  useEffect(() => {
    if (!client) return;
    let live = true;
    client
      .skills(projectPath || undefined)
      .then((s) => live && setSkills(s))
      .catch(() => live && setSkills([]));
    return () => {
      live = false;
    };
  }, [client, projectPath]);
  return skills;
}

/** Leading `/name` words that name skills: `/tdd /grilling fix it` → skills [tdd, grilling], text "fix it". */
export function takeSkillPrefix(text: string, skills: SkillInfo[]): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = text.trimStart();
  while (true) {
    const m = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)\s*/.exec(rest);
    if (!m || !skills.some((s) => s.name === m[1])) break;
    names.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { names, rest };
}

function matchSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  const q = query.toLowerCase();
  const byName = skills.filter((s) => s.name.includes(q));
  const byDesc = skills.filter((s) => !s.name.includes(q) && s.description.toLowerCase().includes(q));
  return [...byName.sort((a, b) => +!a.name.startsWith(q) - +!b.name.startsWith(q)), ...byDesc];
}

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
  onSend(text: string, files: PendingFile[], skills: string[]): Promise<boolean | void> | boolean | void;
  /** Skills the user can select with `/` or the Skills button. */
  skills?: SkillInfo[];
  onStop?(): void;
  /** 1:1 recreation of a URL: shows "Recreate 1:1" for a typed URL and handles `/recreate <url>` */
  onRecreate?(url: string): Promise<boolean | void> | boolean | void;
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
  onRecreate,
  skills = [],
  left,
  right,
}: ComposerProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState<string>();
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

  // Typing `/` (or `/na…`) as the whole draft opens the skill menu.
  // A reserved command typed in full (`/recreate`) runs as the command on Enter, not as a skill pick.
  const slash = /^\/([a-z0-9-]*)$/.exec(text);
  const reserved = slash && onRecreate && slash[1] === "recreate";
  const menu =
    slash && !reserved && skills.length && menuDismissed !== text
      ? matchSkills(skills, slash[1]).slice(0, 8)
      : [];
  const toggleSkill = (name: string) =>
    setSelected((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  const pickFromMenu = (skill: SkillInfo) => {
    if (!selected.includes(skill.name)) setSelected((s) => [...s, skill.name]);
    setText("");
    setMenuIndex(0);
    ta.current?.focus();
  };
  const hint = selected.length === 1 ? skills.find((s) => s.name === selected[0])?.argumentHint : undefined;

  const canSend =
    !disabled && !busy && !sending && (text.trim().length > 0 || files.length > 0 || selected.length > 0);
  const command = onRecreate ? parseRecreateCommand(text) : undefined;
  const url = onRecreate && !disabled ? (command ?? findUrl(text)) : undefined;
  const recreate = async (target: string) => {
    if (!onRecreate || busy || sending) return;
    setSending(true);
    try {
      const ok = await onRecreate(target);
      if (ok !== false) setText("");
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const submit = async () => {
    if (!canSend) return;
    if (command !== undefined) {
      if (!command) return setError("Usage: /recreate https://example.com");
      return recreate(command);
    }
    setSending(true);
    try {
      const typed = takeSkillPrefix(text, skills);
      const names = [...new Set([...selected, ...typed.names])];
      const body =
        typed.rest.trim() ||
        (files.length
          ? "See the attached files."
          : names.length
            ? `Use the ${names.join(" and ")} skill${names.length > 1 ? "s" : ""}.`
            : "");
      const ok = await onSend(body, files, names);
      if (ok !== false) {
        setText("");
        setFiles([]);
        setSelected([]);
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
      {selected.length > 0 && (
        <div className="skill-chips" aria-label="Selected skills">
          {selected.map((n) => (
            <span key={n} className="skill-chip" title={skills.find((s) => s.name === n)?.description}>
              <IconSparkle size={12} /> {n}
              <button type="button" aria-label={`Remove skill ${n}`} onClick={() => toggleSkill(n)}>
                <IconX size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {menu.length > 0 && (
        <div className="skill-menu" role="listbox" aria-label="Skills">
          {menu.map((s, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === Math.min(menuIndex, menu.length - 1)}
              key={s.name}
              className={`option ${i === Math.min(menuIndex, menu.length - 1) ? "active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickFromMenu(s)}
            >
              <span className="option-check">
                <IconSparkle size={13} />
              </span>
              <span className="option-body">
                <span className="option-title">/{s.name}</span>
                <span className="option-desc">{s.description}</span>
              </span>
            </button>
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
        placeholder={disabled && disabledReason ? disabledReason : (hint ?? placeholder)}
        onChange={(e) => (setText(e.target.value), setMenuIndex(0))}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            e.preventDefault();
            void addFiles(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (menu.length && !e.nativeEvent.isComposing) {
            const i = Math.min(menuIndex, menu.length - 1);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setMenuIndex((i + (e.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length);
              return;
            }
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
              e.preventDefault();
              pickFromMenu(menu[i]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMenuDismissed(text);
              return;
            }
          }
          if (e.key === "Backspace" && !text && selected.length) {
            setSelected((s) => s.slice(0, -1));
            return;
          }
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
      {url && (
        <div className="composer-url-action">
          <button
            type="button"
            className="secondary tiny"
            disabled={busy || sending}
            onClick={() => void recreate(url)}
            title="Recreate this page 1:1 from its live DOM (asks for your consent first)"
          >
            <IconCopy size={13} /> Recreate 1:1
          </button>
          <span className="muted small mono" title={url}>
            {url}
          </span>
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
          {/* Where the message goes (project/mode) first, then what to give the agent for it. */}
          {left}
          {skills.length > 0 && <SkillPicker skills={skills} selected={selected} onToggle={toggleSkill} />}
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

/** "Skills" button: search and toggle skills for the next message. */
function SkillPicker({
  skills,
  selected,
  onToggle,
}: {
  skills: SkillInfo[];
  selected: string[];
  onToggle(name: string): void;
}) {
  const [query, setQuery] = useState("");
  const list = query ? matchSkills(skills, query) : skills;
  return (
    <Popover
      className="pick-skills"
      title="Give the agent a skill for this message (or type /)"
      label={
        <>
          <IconSparkle size={14} />
          <span className="pill-text">{selected.length ? `Skills · ${selected.length}` : "Skills"}</span>
        </>
      }
    >
      {() => (
        <div className="picker wide">
          <div className="picker-head">Skills</div>
          <input
            className="skill-search"
            autoFocus
            placeholder="Search skills"
            aria-label="Search skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="picker-list tall">
            {list.map((s) => (
              <button
                type="button"
                key={s.name}
                className={`option ${selected.includes(s.name) ? "active" : ""}`}
                aria-pressed={selected.includes(s.name)}
                onClick={() => onToggle(s.name)}
              >
                <span className="option-check">{selected.includes(s.name) && <IconSparkle size={13} />}</span>
                <span className="option-body">
                  <span className="option-title">
                    {s.name}
                    {s.source !== "builtin" && <span className="muted small"> · {s.source}</span>}
                  </span>
                  <span className="option-desc">{s.description}</span>
                </span>
              </button>
            ))}
            {!list.length && <div className="muted small skill-empty">No skills match.</div>}
          </div>
        </div>
      )}
    </Popover>
  );
}
