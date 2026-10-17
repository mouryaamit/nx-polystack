# Changelog

All notable changes are listed here. Versions follow [semver](https://semver.org); `pstack update`
runs the migrations between the version you have and the one you install.

## 1.0.2

- Generated GitHub workflows use the Node 24 action versions: `actions/checkout`,
  `actions/setup-node`, `actions/cache` and `nrwl/nx-set-shas` v5, and
  `peter-evans/create-pull-request` v8. `pstack update` moves existing workflows
  (`github-actions-node24` migration); other actions and SHA pins are left alone.
- This repository's CI and publish workflows use the same versions; the publish job does not
  cache dependencies.

## 1.0.1

- Releases are published from GitHub Actions through npm trusted publishing, with provenance,
  and each version is approved by the maintainer before it goes live.
- `package.json` `bin` path normalised (no npm warning on publish).

## 1.0.0

First public release on npm: `npm i -g @mouryaamit/nx-polystack`, then `pstack new my-workspace`.

- `pstack` CLI: `new`, `update`, `app`, `lib`, `env`, `migrate`, `build`, `csp`, `hardening`,
  `encryption`, `infra` and `llm`. Inside a workspace it hands commands to the workspace's pinned
  plugin version.
- Apps: Angular 15, Ionic 7 + Capacitor and Flutter, each with per-environment release builds.
- Libraries: TypeScript, Angular, Ionic, Flutter, assets, styles, state, design tokens, session
  timeout and PII masking.
- Release hardening: AES-GCM env encryption, strict CSP with per-request nonces and generated
  `.htaccess`/`nginx.conf`, Subresource Integrity, build-provenance meta, EXIF stripping, leak and
  source-map checks, comment and console stripping, optional obfuscation.
- Migration of standalone Angular CLI, Ionic/Capacitor and Flutter apps, multi-project Angular CLI
  repos, Nx 15–17 workspaces and npm/Yarn/pnpm workspaces, with rollback.
- Repo infrastructure: docs, CI gates, quality checks, a scheduled dependency-upgrade workflow and
  AI assistant context files.
