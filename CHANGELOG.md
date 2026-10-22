# Changelog

All notable changes are listed here. Versions follow [semver](https://semver.org); `pstack update`
runs the migrations between the version you have and the one you install.

## 1.5.0

Angular 18 is supported, the third release of one public release per Angular major.

- **New workspaces on 18:** `pstack new --angular=18` starts on Angular 18.2, Nx 19.8, TypeScript 5.5
  and angular-eslint 18.4.
- **Generators on 18:** apps, Ionic apps and libraries get Angular 18 packages, Ionic 8.7 and
  Capacitor 7. New apps on 18 provide HttpClient with `provideHttpClient(withInterceptorsFromDi())`.
- **Migration on 18:** `pstack migrate` brings in Angular CLI apps, Ionic 8 apps and Nx workspaces on 18. Nx sources that use ESLint flat config get `.eslintrc.json` files in an `.eslintrc` workspace.

Checked by:

- a new Angular 18 workspace with generated apps, an Ionic app and a library: build, lint, test and
  release builds;
- migrated `ng new` 18, Ionic 8 and `create-nx-workspace` 19.8 sources: build, lint and release
  builds.

The 1.4.1 and 1.4.2 entries below were development releases leading to this one.

## 1.4.2

- `pstack migrate` of an Nx workspace that uses ESLint flat config (`eslint.config.js`, the Nx 19+
  default) into a workspace on `.eslintrc.json`: the source's root `eslint.config.js` is no longer
  copied (it switched every project's lint to it), each copied project gets an `.eslintrc.json`
  (Nx defaults plus its selector prefixes) instead of its `eslint.config.js`, and the flat-config
  packages (`typescript-eslint`, `angular-eslint`, `@eslint/js`, …) are not added. The report
  lists what was replaced.

## 1.4.1

- `pstack new --angular=18` starts a workspace on Angular 18.2 with Nx 19.8, TypeScript 5.5 and
  angular-eslint 18.4.
- On an Angular 18 workspace, `pstack app`, `pstack lib` and `pstack migrate` add the Angular 18
  packages. Ionic apps get Ionic 8.7 and Capacitor 7.
- New apps on Angular 18 provide HttpClient with `provideHttpClient(withInterceptorsFromDi())`
  (Angular 18 deprecates `HttpClientModule`). Apps on earlier majors are unchanged.
- The migration report compares an Ionic app's Capacitor with the major the workspace generates
  (it always said 5).

## 1.4.0

Angular 17 is supported, the second release of one public release per Angular major.

- **New workspaces on 17:** `pstack new --angular=17` starts on Angular 17.3, Nx 18.3, TypeScript 5.4
  and angular-eslint 17.3.
- **Generators on 17:** apps, Ionic apps and libraries get Angular 17 packages, Ionic 7.8 and
  Capacitor 6. New apps keep the webpack `browser` builder; `serve` and `extract-i18n` use
  `buildTarget`.
- **Migration on 17:** `pstack migrate` brings in Angular CLI apps, Ionic apps and Nx workspaces on 17,
  and accepts Nx workspaces on Nx 15 to 22.

Checked by:

- a new Angular 17 workspace with generated apps, an Ionic app and a library: build, lint, test and
  release builds;
- migrated `ng new` 17, Ionic 7 and `create-nx-workspace` 18.3 sources: build, lint and release
  builds.

The 1.3.2 and 1.3.3 entries below were development releases leading to this one.

## 1.3.3

- `pstack migrate` accepts Nx workspaces on Nx 15 to 22 (it was 15 to 17), so Angular 17+ Nx
  workspaces can be migrated. When the source's nx.json infers targets with plugins, the report
  says which ones, since inferred targets are not in project.json and are not copied.

## 1.3.2

- `pstack new --angular=17` starts a workspace on Angular 17.3 with Nx 18.3, TypeScript 5.4,
  angular-eslint 17.3, zone.js 0.14, typescript-eslint 7 and eslint-plugin-unused-imports 3.
- On an Angular 17 workspace, `pstack app`, `pstack lib` and `pstack migrate` add the Angular 17
  packages (Ionic apps get Ionic 7.8 and Capacitor 6), and new apps' `serve` and `extract-i18n`
  targets use `buildTarget` (Angular 17 renamed `browserTarget`). Apps keep the webpack `browser`
  builder.
- Workspaces on Nx 18 or later get typescript-eslint 7 when ESLint packages are added.

## 1.3.1

The public release of 1.3.0's changes: Angular 16 support, `pstack new --angular`, and
`pstack upgrade angular`. 1.3.0 was never published to npm (its tag was pushed before the release was
merged, and the tag name cannot be reused). Everything listed under 1.3.0 ships in 1.3.1.

## 1.3.0

Angular 16 is supported. This is the first release of one public release per Angular major.

- **New workspaces on 16:** `pstack new --angular=16`.
- **Generators on 16:** apps, Ionic apps and libraries get Angular 16 packages, Ionic 7.8 and
  Capacitor 6.
- **Migration on 16:** `pstack migrate` brings in Angular CLI apps, Ionic apps and Nx workspaces on 16.
- **Upgrades:** `pstack upgrade angular` moves a workspace one major at a time, from 15 up to 21.
- **Nx versions:** the plugin loads in workspaces on Nx 17 to 22.

Checked by:

- a new Angular 16 workspace with generated apps, an Ionic app and a library: build, lint, test and
  release builds;
- migrated `ng new` 16, Ionic 7 and `create-nx-workspace` 17.0 sources: build, lint and release
  builds;
- `pstack upgrade angular` run from 15 to 21 on a sample workspace.

The README's "Angular versions" table lists what is supported and the known breakpoints of each
upgrade step. The 1.2.8–1.2.15 entries below were development releases leading to this one.

## 1.2.15

- `pstack new --angular=16` (and `:preset --angular=16`) starts a workspace on Angular 16.2, with
  TypeScript 5.1, angular-eslint 16.3 and zone.js 0.13. Without it, nothing changes: the first app
  adds Angular 15.
- On an Angular 16 workspace, `pstack app`, `pstack lib` and `pstack migrate` add the missing
  build, lint and TypeScript packages for Angular 16 (they used to warn and add nothing). Ionic apps
  get Ionic 7.8 and Capacitor 6 there (Capacitor 5 on Angular 15).

## 1.2.14

- `pstack upgrade angular`: the Angular 20 step runs Angular's `inject()` migration
  (`nx g @angular/core:inject`) after installing angular-eslint 20, whose recommended config makes
  `@angular-eslint/prefer-inject` an error, so libraries with constructor injection failed the
  step's lint check. If the migration cannot run, pstack says so and the check reports the rule.

## 1.2.13

- `pstack upgrade angular`: after the Angular 18 migrations, removes `HttpClientModule` left in an
  NgModule's `exports` (or other lists) in files the migration no longer imports it into. Angular's
  own migration leaves it there in shared modules that re-exported `HttpClientModule`, and the
  library build then fails ("Cannot find name 'HttpClientModule'").

## 1.2.12

- New `pstack upgrade angular`: moves the workspace to the next Angular major (15 → 21), one
  step and one commit at a time, with the Nx, TypeScript, build and lint packages, Ionic,
  Capacitor and Node versions tested for that major. It runs `nx migrate`, the second
  `nx migrate @angular/core` pass Nx 22 needs, `@ionic/migrate` for Ionic 9 and `cap migrate`
  for apps with native projects, then `nx run-many -t build lint`. `--to=<major>`, `--yes`,
  `--skip-check`, `--no-commit` and `--dry-run` are supported.

## 1.2.11

- The plugin's peer range is now Nx 17 to 22 (`nx` and `@nx/devkit` `>=17.0.0 <23.0.0`), so strict
  installs in a newer Nx workspace no longer refuse it. Generators, executors and the release
  target were checked on Nx 17 to 22 by walking a workspace from Angular 15 to 21.
- The CLI's file-system tree now comes from one place, with a clear error if a future Nx moves it.
  The `clean` and `flutter-build` executors no longer read `context.workspace`, which Nx 20
  removed (they use `projectsConfigurations`, available since Nx 16).

## 1.2.10

- `pstack migrate` keeps an Angular 20+ app's module resolution. `ng new` writes
  `module: "preserve"` without `moduleResolution`, which TypeScript resolves as `bundler`; once
  the app extended the workspace's `tsconfig.base.json` it got the base's `"node"` instead, and
  the application builder failed (TS5098 on `customConditions`). The migrated tsconfig now sets
  `moduleResolution: "bundler"` in that case.

## 1.2.9

- `pstack migrate` keeps an Angular 17+ app's own builders (`application`, `@angular/build:*`),
  options and tsconfig when the workspace is on Angular 17 or later. Before, it always converted
  them to the Angular 15 browser builder. Angular 15 and 16 workspaces still convert them, as
  before. An application-builder `serviceWorker` path is now moved with the app.
- When the workspace and the source use different Angular majors, `pstack migrate` now says which
  side to update: a newer source needs the workspace brought to its major first, an older source
  needs `ng update`, one major at a time. `--force-angular` still migrates anyway.

## 1.2.8

- Builds say which tool made them: the build meta (`<meta name="x-build">`) of Angular/Ionic
  release builds now carries `gen` (`nx-polystack@<version>`), `ng` (Angular) and `nx` (Nx).
  Flutter web builds get the same build meta, which they did not have before. Release option
  `buildMeta: { "gen": false }` (also on `flutter-build`) leaves the tool fields out.
- New `pstack inspect <dist folder | index.html | URL>`: finds the build meta under any name and
  prints whether pstack made the build, with the versions, env, time, branch and commit
  (`--json` for scripts). The aes-gcm key share is never printed.

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
