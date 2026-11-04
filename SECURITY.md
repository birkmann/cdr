# Security policy

CDR runs AI agents that can read and change files and run commands on your machine. We take reports about ways to escape its safeguards seriously.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting instead (repository **Security** tab → **Report a vulnerability**). Include the steps to reproduce, the affected version or commit, and the impact.

You can expect an acknowledgement within a week. We will tell you when a fix is released and credit you if you wish.

## In scope

- Path confinement: tools reading or writing outside the project, through `..`, absolute paths, or symlinks.
- Permission policy bypasses: commands that run without the approval the active mode requires, or that get past the hard-deny list.
- Secret leaks: provider keys or tokens appearing in events, logs, tool output, shell environments, or the web UI.
- The HTTP server: authentication, CORS, the preview origin, and access to projects outside `allowedRoots`.
- CDR Studio: IPC commands reaching files outside opened workspaces, the sidecar token, and keychain handling.

## Out of scope

- What a model decides to do with the permissions you granted it. Use `ask` mode, sandboxes, or bwrap for untrusted work.
- Running the server on a non-loopback address. `cdr serve` prints a warning because the server can edit files and run commands.

## Supported versions

CDR is pre-1.0. Security fixes go into the latest release on the `main` branch.
