# Changelog

All notable changes are listed here. Versions follow [semver](https://semver.org); `pstack update`
runs the migrations between the version you have and the one you install.

## 1.2.2

- `pstack app --from` keeps `production` in the copied env files (`true` in the prod file); every
  other value is still emptied.

## 1.2.1

- `pstack app --from` asks for the app's folder under apps/ with the new name as the default
  (it must end with the name), defaults the base href to `/` when the base app has none, accepts
  quoted answers, and no longer lists the new title as still naming the base app.

## 1.2.0

- `pstack app --from=<app>` creates a new app from an existing Angular, Ionic or Flutter app: the
  app is copied under the new name with its build, release and hardening configuration, every
  environment value is emptied, and the settings that must differ (folder, port, base href,
  Capacitor appId, environments to keep, CSP allowlist, tags) are asked for in a terminal or given
  as flags (`--yes` for no questions). Secrets, build output, ignored files and the release domain
  lock are not copied; lines that still name the base app are listed.

## 1.1.1

- `pstack update 1.2.0` updates to that version, like `pstack update --to=1.2.0`. Before, the version
  argument was ignored and the global CLI's version was used. Two different versions, or more than
  one argument, are an error.

## 1.1.0

`pstack migrate` closes the gaps its import rewriting and adapter SDK listed:

- Angular `templateUrl`, `styleUrl` and `styleUrls` that reach into another imported project get
  the corrected relative path.
- Bare Sass paths (`@use 'theme'`) are resolved like Sass does, through the source
  `includePaths`; ones the workspace no longer reaches become relative paths, and load-path files
  that were not imported or missing `includePaths` are listed.
- In a `--config` batch, imports between entries are rewritten in both directions; the forward
  ones are undone with the last entry's rollback.
- External adapters can be ES modules (`.mjs`, `"type": "module"`, ESM-only packages; Node 20.19+
  or 22.12+), `.mts` or `.cts` files, and TypeScript adapters resolve tsconfig `paths`.

## 1.0.3

- `pstack update` accepts a plugin entry it cannot read a version from (a git tag of another repo,
  a tarball, `latest`): it migrates from the installed version and rewrites the entry to a normal
  pin. Without an installed copy it still asks you to pin a version first.

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
