# Changelog

All notable changes are listed here. Versions follow [semver](https://semver.org); `pstack update`
runs the migrations between the version you have and the one you install.

## 1.11.10

- `pstack adopt --remove-old-scripts` also removes or rewrites what still names the scripts it
  deletes: ignore-file and `CODEOWNERS` lines, JSON list entries, comment lines in code, CI and
  shell files, and Markdown mentions (now the release target). Changelogs and the adopt reports are
  kept; mentions it cannot edit safely are listed in the report.

## 1.11.9

- `pstack upgrade angular` adds the PostCSS packages that `@nx/angular`'s library builds load when
  they are missing (`postcss-import` after 14 → 15: Angular 14's build packages brought it, 15's do
  not, so buildable libraries failed with "Cannot find module 'postcss-import'"). New buildable
  libraries get `postcss-import` too.

## 1.11.8

- `pstack adopt` adopts Flutter apps: a web build that runs `flutter build web` (directly or
  through the workspace's build script) becomes a `flutter-build` target, with `dist` and base href
  from the script's per-app map, env files and `web/.htaccess` moved under `environments/<app>/`,
  the nonce and HTML comment steps as options, and the npm scripts pointed at it.
- `flutter-build` web builds take `secure`, `nonce` and `stripHtmlComments`, as the release target
  does; the nonce goes on the tags only, so Flutter's inline loader script is kept byte for byte.
- `nonce.tags: "every"` (every script, link and style) and `nonce.ngCspNonce` (the Angular root
  element that gets `ngCspNonce`, for the styles Angular 16+ adds at runtime).
- `pstack adopt` on Angular 17+ application-builder apps keeps `outputPath.base`, reads `baseHref`
  and `dist` from a per-app map in the build script, keeps the names of npm scripts such as
  `build:<app>:production` (now running the release target), and mirrors a listed-mode env
  encryption script (`mode: "listed"`, raw CryptoJS, the listed keys).
- `pstack env --name=uat` works for apps without a UAT env (copied from prod), and only adds env
  configurations and npm scripts to Flutter targets that build with `flutter-build`.

## 1.11.7

- `pstack upgrade angular` starts from Angular 14: the 14 → 15 step keeps Nx 17.0.6, moves tsconfig
  targets to ES2022 (`useDefineForClassFields: false`), turns polyfills files that only load
  zone.js into `polyfills: ["zone.js"]`, and moves zone.js to 0.12 and NgRx to 15.4 when declared.

## 1.11.6

- Angular 14 workspaces get `@angular/cli` and `@angular-devkit/build-angular` 14.2.13, the last
  Angular 14 CLI release (there is no 14.3.0 of them; `pstack new --angular=14` failed to install).

## 1.11.5

- `pstack new --angular=14`: workspaces on Angular 14.3 (Nx 17.0.6, TypeScript 4.8). Apps load
  zone.js from `src/polyfills.ts` and target ES2020; Ionic apps get Ionic 7.8 and Capacitor 5.
  Standalone code is refused on 14, and the starter libraries keep their NgModules without
  `provide*()` functions (NgRx 14.3). `pstack migrate` and `pstack upgrade angular` from 14 follow.
- `pstack upgrade standalone` skips the check and the commit of a step that changed nothing (it
  stopped with "nothing to commit"), and an NgModule that only provides services no longer starts
  Angular's schematic again on an already converted workspace.

## 1.11.4

- `pstack upgrade standalone` has a fourth step, standalone-providers: `importProvidersFrom` in
  `main.ts` and `app.config.ts` loses `BrowserModule`, and the root routing module becomes
  `provideRouter(routes, ...features)` with its router options as features, its file becoming
  `app.routes.ts`. Routing modules it cannot convert safely are left as they are and named. On a
  workspace already converted, `pstack upgrade standalone --all` runs only this step.
- `pstack adopt` also moves the `.htaccess` of apps that already have the release target but whose
  build still copies it (for example an app made by copying another app's `project.json`) to
  `environments/<app>/htaccess.<env>`, keeping env files that exist; `--app` accepts such an app.
  A `project.json` that already had a release target no longer gets a second one.

## 1.11.3

- New workspaces have `"analytics": false` in `nx.json`, so Nx 22 no longer stops the first
  command to ask whether to share usage data. `pstack update` adds it to existing workspaces that
  have not answered; an answer already there is kept.

## 1.11.2

- The generated workspace block in `CLAUDE.md`, `AGENTS.md` and `.github/copilot-instructions.md`
  says whether the workspace uses NgModules or standalone components, with a rule to write new
  Angular code that way, so AI assistants follow the workspace's style. Moving a workspace with
  `pstack upgrade standalone --all` refreshes it; elsewhere run `pstack llm`.

## 1.11.1

- `pstack upgrade standalone` runs `eslint --fix` and Prettier on the `main.ts` files it rewrites
  before the bootstrap step's check and commit, so imports are ordered and no blank lines are left
  behind when the workspace's pre-commit hook formats before it lints.

## 1.11.0

NgModules and standalone components, on every supported Angular (15–21), and a command that moves
one to the other.

- **Choose the style:** `pstack new --standalone` creates a standalone workspace and saves the choice
  in `nx.json` (`pstack.angular.style`). `pstack app` and `pstack lib` (angular, ionic, pii, session,
  state) follow it, or take `--standalone` / `--module` per project. NgModules stay the default.
- **Standalone apps** bootstrap with `bootstrapApplication`, `app.config.ts` and `app.routes.ts`;
  Ionic apps use `provideIonicAngular()` and Ionic's standalone components. **Standalone libraries**
  have no NgModules, and the PII, session and NgRx state libraries export provider functions in both
  styles.
- **`pstack upgrade standalone`** moves an NgModule workspace (`--all`) or some projects
  (`--project`) with Angular's standalone schematic: convert, prune, bootstrap, each checked with
  build and lint and committed. It keeps the CSP nonce import first and zone.js on Angular 21.
- **Security:** Angular 21 is pinned to 21.2.25 and Angular 20 to 20.3.34, and
  `pstack upgrade angular` also moves framework packages that `nx migrate` left on an older patch.
- **Fix:** the pre-commit ESLint step found no ESLint 8+ in warn mode and failed every commit with
  staged TypeScript files; `pstack update` rewrites the script.

Checked by:

- new standalone workspaces on Angular 15 to 21 (apps, an Ionic app, a library and the session, PII
  and state libraries): build, lint, test and release builds, plus migrated `ng new`, Ionic and
  `create-nx-workspace` sources;
- `pstack upgrade standalone --all` on NgModule workspaces on Angular 15 and 21: every step builds,
  lints and commits, and the release build passes.

The 1.10.1 to 1.10.5 entries below were development releases leading to this one.

## 1.10.5

- `pstack upgrade standalone` on Angular 21: `main.ts` no longer imports
  `provideZoneChangeDetection` twice (Angular's bootstrap schematic keeps the import of the
  `applicationProviders` it drops, so the build failed). The `platformBrowserDynamic` import the
  schematic leaves unused is removed.

## 1.10.4

- Fix: the pre-commit ESLint step (`tools/scripts/lint-staged-eslint.js`, warn mode) reported
  "ESLint is not installed" on every commit with staged TypeScript files, because ESLint 8 and later
  do not export `bin/eslint.js`. `pstack update` rewrites the script.
- `pstack upgrade standalone` turns `@angular-eslint/prefer-standalone` back on after its last
  mode, not after the first: the bootstrapped `AppComponent` only becomes standalone in the
  bootstrap mode, so the first check failed lint on Angular 19+.

## 1.10.3

- `pstack upgrade standalone` moves an NgModule workspace to standalone components with Angular's
  schematic, on Angular 15.2–21: convert, prune the NgModules, then `bootstrapApplication`, one
  checked commit per mode. `--all` also sets the workspace style to standalone; `--project` limits
  it to some projects. The CSP nonce import stays first in `main.ts`, and Angular 21 apps keep
  zone.js.
- Security: Angular 21 is pinned to 21.2.25 and Angular 20 to 20.3.34, the patches with the
  latest Angular advisories fixed (template sanitization, `HttpTransferCache`, router SSR).
  `pstack upgrade angular` also moves framework packages that `nx migrate` left on an older patch,
  and on Angular 21 prints the `npm install` command for a workspace whose packages are behind.

## 1.10.2

- `pstack lib --standalone` for `angular`, `ionic`, `pii`, `session` and `state` libraries: no
  NgModules; standalone components, directives and pipes that import what they use. Without the
  flag, libraries follow the workspace style (`pstack new --standalone`); `--module` keeps
  NgModules.
- The PII, session and NgRx state libraries also export provider functions in both styles:
  `providePiiMask()`, `provideSessionTimeout()` and `provide<Name>State()`.

## 1.10.1

- `pstack app --type=angular|ionic --standalone` creates an app on standalone components:
  `bootstrapApplication` in `main.ts`, `app.config.ts` and `app.routes.ts` instead of `AppModule`
  and `AppRoutingModule`, on every supported Angular (15–21). Ionic apps get
  `provideIonicAngular()` and Ionic's standalone components. `--module` keeps NgModules.
- `pstack new --standalone` makes standalone the workspace default (nx.json
  `pstack.angular.style`); apps follow it unless `--module` is passed. Without it, nothing changes:
  new apps use NgModules.
- `pstack encryption --cipher=aes-gcm` also rewrites a `bootstrapApplication(…)` main.ts to await
  `envReady` first.

Angular 21 is supported, the sixth release of one public release per Angular major, and the last
major `pstack upgrade angular` reaches today.

- **New workspaces on 21:** `pstack new --angular=21` starts on Angular 21.2, Nx 22.7, TypeScript 5.9,
  angular-eslint 21 and zone.js 0.16, with Node 22 in `.nvmrc` and `moduleResolution: "bundler"`.
- **Generators on 21:** apps keep zone.js change detection (Angular 21 is zoneless by default) with
  `applicationProviders: [provideZoneChangeDetection()]`. Ionic apps and libraries get Ionic 9 and
  Capacitor 8 and import from `@ionic/angular/lazy`. The session library's warning uses `@let` and
  `@if`, as angular-eslint 21 reports `*ngIf`.
- **Migration on 21:** `pstack migrate` brings in Angular CLI apps, Ionic 9 apps and Nx workspaces on
  21 (Nx 22.7).
- Generated Ionic apps ignore the web build Capacitor copies into `android/` and `ios/`.

Checked by:

- a new Angular 21 workspace with generated apps, an Ionic app, a library and the session, PII and
  state libraries: build, lint, test and release builds;
- migrated `ng new` 21 (with environment files), Ionic 9 and `create-nx-workspace` 22.7 sources:
  env files moved, build, lint and release builds. These run on Node 22 with npm 11; the npm 10.9
  that ships with Node 22 fails to install new Angular 21 projects.

The 1.9.1 and 1.9.2 entries below were development releases leading to this one.

## 1.9.2

- `pstack new --angular=21` sets `moduleResolution: "bundler"` in `tsconfig.base.json`: Angular 21's
  packages and Ionic 9's `@ionic/angular/lazy` declare their entry points only in `exports`, which
  `"node"` resolution does not read (builds failed with `Cannot find module '@angular/common/http'`).
- The session library's warning template uses `@let` and `@if` on Angular 21, whose angular-eslint
  rules report `*ngIf` (`prefer-control-flow`).

## 1.9.1

- `pstack new --angular=21` creates a workspace on Angular 21.2, Nx 22.7, TypeScript 5.9,
  angular-eslint 21 and zone.js 0.16, with `22` in `.nvmrc`; `pstack app`, `pstack lib` and
  `pstack migrate` add packages for a workspace on 21.
- Angular 21 is zoneless by default; generated apps on 21 keep zone.js change detection by passing
  `applicationProviders: [provideZoneChangeDetection()]` to `bootstrapModule`, as Angular's own
  migration does.
- Ionic apps and libraries on 21 get Ionic 9 and Capacitor 8, and import `IonicModule` and
  `IonicRouteStrategy` from `@ionic/angular/lazy` (Ionic 9 moved them there).
- Generated Ionic apps ignore the web build Capacitor copies into `android/` and `ios/`.

## 1.9.0

Angular 20 is supported, the fifth release of one public release per Angular major.

- **New workspaces on 20:** `pstack new --angular=20` starts on Angular 20.3, Nx 21.6, TypeScript 5.9,
  angular-eslint 20.7 and zone.js 0.15.
- **Generators on 20:** apps, Ionic apps and libraries get Angular 20 packages, Ionic 8.7 and
  Capacitor 7. angular-eslint 20 makes `prefer-inject` an error, so the session, PII and NgRx state
  libraries now inject with `inject()` (on every Angular major).
- **Migration on 20:** `pstack migrate` brings in Angular CLI apps, Ionic 8 apps and Nx workspaces on
  20 (Nx 21.6). An app whose code still injects through constructor parameters gets `prefer-inject`
  turned off, and the report says how to run Angular's `inject()` migration.

Checked by:

- a new Angular 20 workspace with generated apps, an Ionic app, a library and the session, PII and
  state libraries: build, lint, test and release builds;
- migrated `ng new` 20 (with environment files), Ionic 8 and `create-nx-workspace` 21.6 sources:
  env files moved, build, lint and release builds.

The 1.8.8 entry below was the development release leading to this one.

## 1.8.8

- `pstack new --angular=20` creates a workspace on Angular 20.3, Nx 21.6, TypeScript 5.9,
  angular-eslint 20.7 and zone.js 0.15; `pstack app`, `pstack lib` and `pstack migrate` add packages
  for a workspace on 20. Ionic apps keep Ionic 8.7 and Capacitor 7.
- angular-eslint 20 makes `@angular-eslint/prefer-inject` an error, so the generated session,
  PII and NgRx state libraries now inject with `inject()` instead of constructor parameters, on
  every Angular major.
- `pstack migrate` into an Angular 20 workspace turns `prefer-inject` off in the app's generated
  ESLint config when the copied code injects through constructor parameters, and the report says
  how to run Angular's `inject()` migration.
- `pstack update --run-migration` needs 1.8.7 in the workspace (the 1.8.7 notes said 1.8.6, which
  was never published).

## 1.8.7

(The `v1.8.6` tag was created on the 1.8.5 commit by mistake and never published to npm; these
changes ship as 1.8.7.)

- `pstack update --run-migration=<name,...>` runs migrations of the installed plugin again, whatever
  their version (an update only runs those newer than the version it starts from, so a workspace
  that skipped one could not get it), and `pstack update --list-migrations` lists them. Needs 1.8.6
  or later installed in the workspace.
- `pstack adopt --remove-old-scripts` no longer deletes, on a later run, the scripts an earlier
  report listed as not part of the old build and left in place. A later run that finds nothing left
  to remove now says so in the report instead of keeping the earlier list.

## 1.8.5

- `pstack adopt --report=<path>` writes the report somewhere else (a folder ending in `/` gets
  `pstack-adopt.md`) and `--no-report` writes none, for repos that only allow Markdown in some
  folders. The choice is saved as `pstack.adopt.report` in `nx.json`; a report already at
  `docs/migrations/adopt.md` moves to the new path.
- `pstack adopt --compare --old-dir=<path> --env=<env>` compares against a build made elsewhere,
  such as a clone of the main branch with its own `npm install`, instead of a worktree that shares
  this checkout's `node_modules`.

## 1.8.4

- `pstack adopt --remove-old-scripts` counts a `tools/` script that app or library code imports
  (`import '../../../tools/scripts/x'`) as in use: it is kept and no longer listed as a script
  nothing starts.

## 1.8.3

- `pstack adopt` in a workspace whose Angular apps all build with the release target already (adopted
  app by app, or before 1.8.0) moves `build:all:<env>` scripts that still run the workspace's own
  script to `nx run-many -t release -c <env>`; with `--remove-old-scripts`, that script and the
  helpers only it loaded are removed too. Before, they stayed, and so did the helpers they kept alive.

## 1.8.2

- `pstack adopt --compare` counts the obfuscated names the release target writes with its per-file
  prefix (`_p1a2b3c_0x…`); it counted only half of them and reported obfuscation as weaker than it
  is. Its report also says why vendor, polyfills and runtime can differ (module paths, as the old
  build runs from a worktree).

## 1.8.1

- Layout-keeping JSON edits (`pstack update`, `pstack upgrade nx|angular`, `pstack adopt`) add a new key
  in alphabetical place when the object was sorted (dependencies), so `@nrwl/*` renamed to `@nx/*` no
  longer lands at the end of `devDependencies`. Found running `pstack upgrade nx` on an 18-app Nx 15
  workspace.

## 1.8.0

- **`pstack upgrade nx`** moves an Nx 15 or 16 workspace to Nx 17.0.6, where the plugin loads: one
  `nx migrate` per major (16.9.1, then 17.0.6), each with `npm install`, the migrations, a build check
  and one commit. Angular and its packages stay where they are (with their migrations left out), the
  plugin comes out of `package.json` for the steps and goes back with `@nx/devkit` pinned to the new
  Nx, JSON files keep their layout, and the Markdown and binary files `nx migrate` text-replaces are
  put back. The newest Nx CLI's provenance check and version lookup are worked around (the pinned
  versions, then the workspace's own Nx).
- **`pstack upgrade angular`** gets the same tidying for its `nx migrate` steps (JSON layout,
  Markdown and binary files, `"v17.0.6"`-style versions, `@nx/devkit` pinned) and the same CLI
  fallback.
- **`@nx/devkit` pinned**: `pstack update` installs `@nx/devkit` of the workspace's Nx together with
  the plugin (npm otherwise resolves the plugin's devkit peer to the newest Nx and fails), and
  `pstack adopt` pins it in `package.json`.
- **`pstack adopt`**: `build:all:<env>` scripts that ran the workspace's own script become
  `nx run-many -t release -c <env>` when every app is adopted. `--remove-old-scripts` deletes the old
  build pipeline scripts nothing uses any more (npm scripts, project.json, CI and git hooks are
  checked; unused scripts outside the old build are listed, not deleted). `--compare --app=<app>`
  builds the app with the old script (in a git worktree of `--base`) and with its release target for
  each env and compares the file set, `.htaccess`, CSP nonce, build commit meta, encrypted env values,
  obfuscation and image metadata, in `dist/pstack-compare/<app>/report.md`.
- On an Nx 15 or 16 workspace, `pstack` now points at `pstack upgrade nx`.

## 1.7.2

- **`pstack adopt` obfuscation**: adopt wrote `obfuscate: true`, which the release target rejects
  (it takes a profile). It now reads the obfuscate script (its default profile and shared options)
  and sets the closest preset plus `obfuscateOptions` for the string threshold, name style and
  wrappers it sets differently, so the output matches the old script's. Every option adopt writes
  is now checked against the build executor's schema in the tests.
- **Older Nx stops early**: commands that load the plugin (`adopt`, `update`, `app`, `lib`, `env`,
  `build`, …) stop with the `nx migrate` steps when the workspace is on Nx 15 or 16, and ask for
  `@nx/devkit` pinned to the workspace's Nx when another major is installed. Before, npm only
  reported a peer-dependency conflict, or the plugin failed to load. The README and the user manual
  install `@nx/devkit` next to the plugin.
- **`pstack update` keeps the JSON layout**: migrations write `package.json`, `nx.json`,
  `project.json`, `tsconfig*.json` and `.eslintrc.json` through Prettier or `writeJson`, which
  re-laid-out whole files (one-line objects spread over several lines). After the migrations,
  `pstack update` puts each file's own layout back and keeps only the changed values.

## 1.7.1

- **`pstack adopt`** moves the Angular apps of a workspace that still build with the repo's own
  scripts (`@angular-devkit/build-angular:browser` plus e.g. `tools/scripts/build.js`) to the
  plugin's `release` target, in place: base hrefs and env folder from the existing setup, the CSP
  nonce, HTML comment stripping and obfuscation as the script did them, `environments/<app>/htaccess.<env>`
  from the `.htaccess` build asset, env encryption mirrored in `nx.json`, and `build:<app>:<env>`
  (plus `:prod:secure` and `:prod:secure:sri`) pointing at `nx run <app>:release:<env>`. It keeps the
  layout of `package.json` and `project.json` and leaves the old scripts in place. `pstack update`
  does not do this: it only changes apps that already build through the release target.

## 1.7.0

Angular 19 is supported, the fourth release of one public release per Angular major.

- **New workspaces on 19:** `pstack new --angular=19` starts on Angular 19.2, Nx 20.8, TypeScript 5.8,
  angular-eslint 19.8 and zone.js 0.15.
- **Generators on 19:** apps, Ionic apps and libraries get Angular 19 packages, Ionic 8.7 and
  Capacitor 7. Angular 19 makes components, directives and pipes standalone by default; generated
  code keeps its NgModules, marks their declarations `standalone: false` (as Angular's own migration
  does) and turns off angular-eslint 19's `prefer-standalone` in their `.eslintrc.json`.
- **Migration on 19:** `pstack migrate` brings in Angular CLI apps, Ionic 8 apps and Nx workspaces on
  19 (Nx 20.8). An NgModule app migrated into a 19 workspace gets the same `prefer-standalone`
  setting.

Checked by:

- a new Angular 19 workspace with generated apps, an Ionic app and a library: build, lint, test and
  release builds;
- migrated `ng new` 19 (with environment files), Ionic 8 and `create-nx-workspace` 20.8 sources:
  env files moved, build, lint and release builds.

The 1.6.1 and 1.6.2 entries below were development releases leading to this one.

## 1.6.2

- Generated apps and libraries on Angular 19 turn off angular-eslint 19's
  `@angular-eslint/prefer-standalone` in their `.eslintrc.json`: with 1.6.1 their NgModule
  declarations (`standalone: false`) failed `lint`. Nx 20.2's own migration does the same for
  upgraded workspaces.
- `pstack migrate` into an Angular 19 workspace does the same in the `.eslintrc.json` it generates
  for an app whose code declares `standalone: false`.

## 1.6.1

- `pstack new --angular=19` starts a workspace on Angular 19.2 with Nx 20.8, TypeScript 5.8,
  angular-eslint 19.8 and zone.js 0.15.
- On an Angular 19 workspace, `pstack app`, `pstack lib` and `pstack migrate` add the Angular 19
  packages. Ionic apps get Ionic 8.7 and Capacitor 7.
- Angular 19 makes components, directives and pipes standalone by default. Generated apps and
  libraries on 19 keep their NgModules and mark what those declare `standalone: false`, as Angular's
  own migration does. Earlier majors are unchanged.

## 1.6.0

Every per-environment file of a project now lives in `environments/<project>/`, web release builds
use an Apache config per environment, and CSP sources can differ per environment.

- **`.htaccess` per environment:** `environments/<app>/htaccess.<env>` for each release env. A
  release build (Angular and Ionic `release`, Flutter `build-web`) removes every `.htaccess` from
  the output and copies that env's file into the served folder; a missing file stops the build.
  The `htaccess` option (default `true`) turns it off. Capacitor `sync`/`copy` removes `.htaccess`
  from the native bundles.
- **Flutter env files:** `environments/<app>/environment.<env>.json` instead of
  `apps/<app>/env/<env>.json`; `flutter-build` takes any env name and an `envProject` option.
- **Per-env CSP sources:** `csp-allowlist.json` takes `envs`, the sources one release env adds.
  `pstack csp --app=<app> --env=<env> --add=…` / `--remove=…` edit them; only that env's
  `htaccess.<env>` gets them, `nginx.conf` keeps the base sources.
- **Generators:** `pstack app` writes the new layout for Angular, Ionic and Flutter;
  `pstack app --from` copies and re-renders every env's file; `pstack env --name=<env>` copies
  `htaccess.prod` and the `envs.prod` CSP sources to the new env.
- **`pstack migrate`** moves env files into `environments/<name>/` for every Angular and Ionic app
  and library it brings in (fileReplacements, the release `envProject` and imports follow), moves
  a Flutter app's env files, and turns a `.htaccess` build asset into per-env files.
- **`pstack update`** moves existing workspaces to the new layout (migration `env-files-layout`):
  `.htaccess` assets become `htaccess.<env>` files (`"htaccess": false` for apps that built none),
  Flutter env files move, Flutter targets on the earlier `tools/scripts/flutter/flutter-build.js`
  commands become the plugin's `flutter-build` targets, and npm scripts, GitHub workflows and
  Jenkinsfiles that still name an old path are listed. Existing files are never replaced.

Checked by:

- new Angular 15, 16, 17 and 18 workspaces with generated apps, an Ionic app and a library: build,
  lint, test and release builds;
- migrated `ng new` and Ionic sources with environment files, and `create-nx-workspace` sources,
  on each of those majors: env files moved, build, lint and release builds;
- a Flutter web release build reading `environments/<app>/environment.uat.json`, with and without
  `htaccess.uat`.

The 1.5.1 to 1.5.5 entries below were development releases leading to this one.

## 1.5.5

- **Per-env CSP sources:** `csp-allowlist.json` takes `envs`, the sources one release env adds,
  e.g. `"envs": { "uat": { "connect-src": ["https://uat-api.example.com"] } }`. Only that env's
  `environments/<app>/htaccess.<env>` gets them; `nginx.conf` (one per app) keeps the base sources.
  `pstack csp --app=<app> --env=<env> --add=…` / `--remove=…` edit them (the env must be a release
  configuration of the app); `pstack csp` lists each env's sources and policy.
- `pstack env --name=<env>` copies `envs.prod` to the new env along with `htaccess.prod`, so
  `pstack csp` renders the same file.
- `pstack app --from` renders each copied `htaccess.<env>` with that env's sources.

## 1.5.4

- **`pstack migrate` moves env files into `environments/<name>/`**, the layout `pstack app` uses,
  for every Angular and Ionic app and library it brings in (Angular CLI apps and workspaces, Ionic
  apps, Nx and npm/pnpm/Yarn workspaces): the `environment*.ts` files of the folder the
  fileReplacements use, with the fileReplacements, the release target's `envProject` and the
  imports pointed at them (imports then go through `@env/<name>/…`). Build-time env encryption
  (`nx run <app>:release:<env>`) now works on a migrated app without moving files by hand. Nothing
  moves when a file exists already in `environments/<name>/`, when the fileReplacements use more
  than one folder, or with `--no-rewrite-imports`; the report says so.
- `env-files-layout` (the `pstack update` migration of 1.5.2) leaves the root tsconfig's `paths`
  in their order.

## 1.5.3

- `env-files-layout` (the 1.5.2 `pstack update` migration) also lists direct calls of
  `tools/scripts/flutter/flutter-build.js --project=<app>` for apps whose env files moved: that
  script reads `apps/<app>/env/<env>.json` and skips a missing file without an error. Use
  `nx run <app>:build-android:<env> --obfuscate` (or `build-ios`) instead.
- The `project.json` files it changes keep the workspace's Prettier style.

## 1.5.2

- **`pstack update` moves existing workspaces to the 1.5.1 env-file layout** (migration
  `env-files-layout`):
  - the `.htaccess` an Angular or Ionic app's build copied becomes `environments/<app>/htaccess.<env>`
    for each release env (identical copies) and leaves the build assets; an app that built none
    gets `"htaccess": false`; apps already on env files are kept, with a note for envs that have no
    file;
  - Flutter env files move from `apps/<app>/env/<env>.json` to
    `environments/<app>/environment.<env>.json`, and `build-web` gets `"htaccess": false`;
  - Flutter targets on `node tools/scripts/flutter/flutter-build.js … --env={args.env}` (the form
    earlier workspaces had) become the plugin's `flutter-build` targets
    (`nx run <app>:build-web:<env>`);
  - existing files are never replaced; npm scripts, GitHub workflows and Jenkinsfiles that still
    name an old path or pass `--args` to a converted target are listed, not rewritten.
- The release target's `.htaccess` asset is found on the target its `buildTarget` names, not only
  on `build`.

## 1.5.1

Every per-environment file of a project now lives in `environments/<project>/`, and web release
builds use an Apache config per environment.

- **`.htaccess` per environment:** `environments/<app>/htaccess.<env>` for each release env
  (`htaccess.dev`, `htaccess.uat`, `htaccess.prod`). A release build (Angular and Ionic
  `release`, Flutter `build-web`) removes every `.htaccess` from the output and copies that env's
  file into the served folder as `.htaccess`. A missing file stops the build, naming the app, the
  env and the expected path; there is no fallback. Plain `nx build` adds none. The new `htaccess`
  option (default `true`) turns it off. Capacitor `sync`/`copy` removes `.htaccess` from the native
  bundles.
- **Flutter env files:** `environments/<app>/environment.<env>.json` instead of
  `apps/<app>/env/<env>.json`; `flutter-build` takes any env name and an `envProject` option.
  Flutter apps get `htaccess.<env>` files for their web builds.
- **`pstack app`** writes the new layout for Angular, Ionic and Flutter; the build target no
  longer ships `src/.htaccess` as an asset. **`pstack app --from`** copies and re-renders every
  env's file.
- **`pstack csp`** writes every release env's `htaccess.<env>` (none with `htaccess: false`).
- **`pstack env --name=<env>`** copies `htaccess.prod` to `htaccess.<env>` for builds that use
  one, and refuses when `htaccess.prod` is missing or `htaccess.<env>` exists.
- **`pstack migrate`** moves a migrated Flutter app's env files into `environments/`, and turns a
  migrated Angular app's `.htaccess` asset into per-env files (`htaccess: false` when it had none).

Existing workspaces: `pstack update` does not move existing apps to this layout yet; that
migration comes in the next release. Until then a release build of an app made before 1.5.1 needs
`environments/<app>/htaccess.<env>` (or `"htaccess": false`), and Flutter apps need their env
files moved by hand.

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
