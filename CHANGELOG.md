# Changelog

All notable changes are listed here. Versions follow [semver](https://semver.org); `pstack update`
runs the migrations between the version you have and the one you install.

## 1.2.7

- Apps import their env file as `@env/<app>/environment` through a new `@env/*` alias in
  `tsconfig.base.json`, instead of a relative path into `environments/`. Nx 18 and later refuse the
  relative form in `@nx/enforce-module-boundaries`, which blocked lint after an Angular 17+ upgrade.
  `pstack update` (migration `env-import-alias`) adds the alias and rewrites the existing imports;
  `pstack app`, `pstack app --from` and `pstack migrate` use it too.

## 1.2.6

- Release builds encrypt env values in every env, DEV included (before, only non-DEV builds did).
  The env file is encrypted only for the build and restored afterwards, so `nx serve` still reads
  the plain file; DEV files still may not hold `${VAR}` placeholders. DEV builds now also skip the
  Nx cache, like the others, since the env file changes per build.

## 1.2.5

- The release build's CSP nonce (`secure`) and SRI (`sri`) now rewrite only the served
  `index.html`: other pages and everything under `assets/` (e.g. third-party viewer locale pages)
  stay byte-identical. Tags are parsed with quotes and SSI directives respected, so integrity is
  never written inside a nonce placeholder and edited tags get no double spaces.
- New release options to match an existing server setup: `nonce.placeholder`, `nonce.tags`
  (`all` | `legacy`), `nonce.position` (`end` | `after-tag-name`), `nonce.replaceTokens`,
  `nonce.addMeta`, `nonce.files`, and `stripHtmlComments` (every env). Defaults keep the
  standard markup.
- `pstack csp`: `nonce-source` (`mod_unique_id`, or `env:NAME` for a variable the server sets,
  e.g. `UNIQUE_ID` from mod_lua; also `--nonce-source`), `unset-headers`, `referrer-policy`,
  `extra-headers` and `ssi` (`index` | `html`) in `csp-allowlist.json`; `'sha256/384/512-…'`
  hashes are allowed in `script-src`/`style-src`, and `--import` keeps them (also from
  `script-src-elem`/`style-src-elem`).

## 1.2.4

- Angular and Ionic builds strip EXIF in every env (DEV, UAT, PROD, custom), not only PROD. Only
  images that have EXIF are rewritten, so the rest of the output stays byte-identical.
- Flutter web builds (`flutter-build`, `target: web`) strip EXIF the same way. It is on by default;
  set `"stripExif": false` in the target's options to turn it off. apk and ios builds are not
  touched (the images are inside the app bundle).

## 1.2.3

- PROD builds strip EXIF only from images that have it. Images without EXIF are no longer
  re-encoded, so their bytes stay identical (before, every .jpg/.png/.webp was re-saved, which could
  make optimised PNGs larger and re-compress JPEGs). The build logs
  `strip-exif: <n> scanned, <n> stripped, <n> unchanged, <n> skipped`, and `stripExif()` returns
  those counts.

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
