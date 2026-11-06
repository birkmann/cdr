# Contributing to CDR

Thanks for your interest. Bug reports, ideas, and pull requests are welcome. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Requirements:

- Node.js 22 or newer.
- pnpm 11.
- Git.
- For the desktop app: Rust 1.80+ and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Linux these include WebKitGTK 4.1.

```bash
pnpm install
pnpm build          # TypeScript packages, the web app, and the desktop UI
pnpm test           # unit and integration tests (mock models, no network)
pnpm lint           # Prettier check and type-check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

The repository layout and conventions are in [AGENTS.md](AGENTS.md). The same rules apply to people and to coding agents.

## Making a change

1. Open an issue first for larger changes, so we can agree on the approach.
2. Keep pull requests focused. Add or update tests for behaviour you change.
3. Every agent step is an event. New event types go into `@harness/protocol`, `reduceSession`, and the CLI renderer. Afterwards, regenerate the schemas with `pnpm --filter @harness/protocol schema`.
4. Tests must not call real models or the network. Use `MockProvider`.
5. Never log or emit secrets.
6. Update the docs in `docs/` when behaviour or configuration changes.
7. Run `pnpm format` before committing.

## End-to-end tests

These need a desktop session:

```bash
pnpm --filter web test:e2e                        # needs Chrome or Chromium
cargo install tauri-driver --locked               # once; Linux also needs WebKitWebDriver
cargo build -p studio-app --features tauri/custom-protocol
pnpm --filter desktop test:e2e
```

## Screenshots

The README images are generated from the real apps with a scripted demo model, so no API key is needed:

```bash
pnpm build && cargo build -p studio-app --features tauri/custom-protocol
pnpm screenshots            # or name targets: node scripts/screenshots/capture.mjs web terminal terminal-classic terminal-approval desktop
```

## Releasing

CDR has one version for every package, crate, and app.

1. Write the release notes under `## Unreleased` in `CHANGELOG.md` and commit them.
2. Optional: test the builds first. Run the **Release** workflow by hand from the Actions tab. It builds everything and uploads the results as workflow artifacts, without publishing anything.
3. Set the version, then commit, tag, and push:

   ```bash
   pnpm release:version 0.2.0 --push      # use 0.2.0-beta.1 for a prerelease
   ```

The tag starts the **Release** workflow:

- It checks that the tag matches the version.
- It builds CDR Studio for Linux (AppImage, `.deb`, `.rpm`), macOS (universal `.dmg`), and Windows (installer and `.msi`).
- It packages the terminal and web app as `cdr-<version>.tar.gz` and `.zip`.
- It publishes a GitHub release with the changelog notes and `SHA256SUMS.txt`.

Prereleases are marked as such and skip the `.msi`, because MSI versions must be numeric.

Without `--push`, the script prints the push commands instead. `pnpm release:cli` builds the terminal and web app archive locally.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
