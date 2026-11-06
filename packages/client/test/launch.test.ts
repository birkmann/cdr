import { describe, expect, it } from "vitest";
import { turnLaunches, type ToolCallView } from "@harness/client";

const write = (path: string, content: string, status: ToolCallView["status"] = "ok"): ToolCallView => ({
  id: path,
  name: "write_file",
  args: { path, content },
  status,
});

describe("turnLaunches", () => {
  it("keeps the latest declared launch per folder and command", () => {
    const ev = (seq: number, command: string, title?: string) =>
      ({ type: "launch.ready", command, title, framework: "rust", seq, sessionId: "s", ts: "" }) as never;
    const out = turnLaunches([ev(1, "cargo run", "old"), ev(2, "cargo test"), ev(3, "cargo run", "new")], []);
    expect(out.map((l) => [l.command, l.title])).toEqual([
      ["cargo test", undefined],
      ["cargo run", "new"],
    ]);
  });

  it("infers a Rust or Go program from the shallowest manifest written in the turn", () => {
    expect(
      turnLaunches(
        [],
        [
          write("/p/game/Cargo.toml", '[package]\nname = "a"'),
          write("/p/Cargo.toml", '[package]\nname = "b"'),
        ],
        "/p",
      ),
    ).toEqual([{ command: "cargo run --release", framework: "rust", inferred: true }]);
    expect(turnLaunches([], [write("cli/go.mod", "module x\n")])).toEqual([
      { command: "go run .", cwd: "cli", framework: "go", inferred: true },
    ]);
  });

  it("ignores failed writes, workspaces-only manifests, Tauri apps and paths outside the project", () => {
    expect(
      turnLaunches(
        [],
        [
          write("Cargo.toml", '[package]\nname = "a"', "error"),
          write("ws/Cargo.toml", "[workspace]\nmembers = []"),
          write("app/src-tauri/Cargo.toml", '[package]\n[dependencies]\ntauri = "2"'),
          write("/elsewhere/Cargo.toml", "[package]"),
          write("../up/go.mod", "module x"),
        ],
        "/p",
      ),
    ).toEqual([]);
  });
});

describe("turnLaunches from shell commands", () => {
  const bash = (command: string, status: ToolCallView["status"] = "ok"): ToolCallView => ({
    id: command,
    name: "bash",
    args: { command },
    status,
  });

  it("finds a Cargo.toml written with a heredoc and cargo builds run in the project", () => {
    const heredoc = bash("cd /p && cat > Cargo.toml <<'EOF'\n[package]\nname = \"snake\"\nEOF\necho done");
    expect(turnLaunches([], [heredoc], "/p")).toEqual([
      { command: "cargo run --release", framework: "rust", inferred: true },
    ]);
    expect(
      turnLaunches([], [bash("cd /p/game && export X=1 && cargo build --release 2>&1 | tail")], "/p"),
    ).toEqual([{ command: "cargo run --release", cwd: "game", framework: "rust", inferred: true }]);
    expect(turnLaunches([], [bash("cd cli; go build ./...")], "/p")).toEqual([
      { command: "go run .", cwd: "cli", framework: "go", inferred: true },
    ]);
  });

  it("ignores builds outside the project, failed commands and unrelated shell work", () => {
    expect(
      turnLaunches(
        [],
        [
          bash("cd /tmp/probe && cargo build"),
          bash("cargo build", "error"),
          bash("cat Cargo.toml"),
          bash("ls"),
        ],
        "/p",
      ),
    ).toEqual([]);
  });

  it("treats a written src/main.rs as a Rust binary crate", () => {
    expect(turnLaunches([], [write("/p/app/src/main.rs", "fn main() {}")], "/p")).toEqual([
      { command: "cargo run --release", cwd: "app", framework: "rust", inferred: true },
    ]);
  });
});
