# @mouryaamit/nx-polystack

An Nx 17 plugin and the `pstack` CLI for monorepos that mix **Angular**, **Ionic + Capacitor** and
**Flutter** apps. It scaffolds workspaces, apps and shared libraries, and wires a hardened release
pipeline into every app, so they are all built the same way.

[![npm](https://img.shields.io/npm/v/@mouryaamit/nx-polystack)](https://www.npmjs.com/package/@mouryaamit/nx-polystack)
[![license](https://img.shields.io/npm/l/@mouryaamit/nx-polystack)](LICENSE)

## Install

```bash
npm i -g @mouryaamit/nx-polystack nx@22 @nx/devkit@22
pstack new my-workspace --npmScope=acme --ci=github-actions
cd my-workspace
pstack app --type=angular --name=portal
pstack app --type=ionic --name=field-app --appId=com.acme.fieldapp
pstack app --type=flutter --name=mobile
pstack app --from=portal --name=partner-portal   # a copy of portal, env values emptied
```

`pstack new` pins the plugin in the workspace. Inside a workspace, `pstack` hands commands to that
pinned copy, so output always matches the workspace's version. Move a workspace to a new release
with `pstack update`, which installs it and runs its migrations.

`nx` and `@nx/devkit` are optional peer dependencies (since 1.24.0, so apps that only import a
runtime file do not get Nx), which is why the global install names them; without them, commands
that need them stop with this install hint.

Requires Node 20 and npm 10+. `pstack new` creates Nx 17 workspaces on Angular 15 or, with
`--angular=16`, Angular 16, and Nx 18 workspaces with `--angular=17`; the plugin itself loads in workspaces on Nx 17 to 22.

## Angular versions

Each release adds one Angular major and keeps every earlier one.

| Angular | Nx     | TypeScript | Ionic | Capacitor | Node | Status             |
| ------- | ------ | ---------- | ----- | --------- | ---- | ------------------ |
| 15.2    | 17.0.6 | 4.9        | 7.8   | 5         | 20   | supported          |
| 16.2    | 17.0.6 | 5.1        | 7.8   | 6         | 20   | supported (1.3.1)  |
| 17.3    | 18.3.5 | 5.4        | 7.8   | 6         | 20   | supported (1.4.0)  |
| 18.2    | 19.8   | 5.5        | 8.7   | 7         | 20   | supported (1.5.0)  |
| 19.2    | 20.8   | 5.8        | 8.7   | 7         | 20   | supported (1.7.0)  |
| 20.3    | 21.6   | 5.9        | 8.7   | 7         | 20   | supported (1.9.0)  |
| 21.2    | 22.7   | 5.9        | 9     | 8         | 22   | supported (1.10.0) |

Supported means:

- `pstack new --angular=<major>` creates a workspace on that major;
- its apps and libraries generate, build, lint, test and release-build;
- `pstack migrate` brings in standalone Angular CLI and Ionic apps and Nx workspaces of the same major;
- `pstack upgrade angular` moves a workspace there from the previous major.

`pstack upgrade angular` moves a workspace one major at a time, with one commit per step. Each step
pins Nx, TypeScript, the build and lint packages, Ionic, Capacitor and Node. It works up to Angular 21,
the newest major the generators support.

Known breakpoints when upgrading:

- **16:** View Engine libraries no longer load.
- **17:** Nx 18's module-boundary rule refuses relative environment imports (pstack uses `@env/*`).
- **18:** `HttpClientModule` can be left in an NgModule's lists; `pstack upgrade angular` removes it.
  New apps on 18 provide HttpClient with `provideHttpClient(withInterceptorsFromDi())`.
- **19:** components, directives and pipes are standalone by default; Angular's migration adds
  `standalone: false` to NgModule declarations, and new apps and libraries on 19 write it.
- **20:** angular-eslint 20 makes `prefer-inject` an error; the step runs Angular's `inject()` migration.
  Generated code injects with `inject()`.
- **21:** Node 22 is required, Ionic 9 comes through `@ionic/migrate`, and Capacitor moves to 8.
  Angular 21 is zoneless by default; new apps on 21 keep zone.js with `provideZoneChangeDetection()`,
  import `IonicModule` from `@ionic/angular/lazy` and resolve modules as `bundler`. Use npm 11: the
  npm 10.9 that ships with Node 22 fails to install new Angular 21 projects (`ng new`,
  `create-nx-workspace`).

### NgModules or standalone components

Every supported major (15–21) works both ways. New workspaces use NgModules unless you pass
`pstack new --standalone`, which saves the choice in `nx.json` (`pstack.angular.style`); new apps and
libraries follow it, and `pstack app` / `pstack lib` take `--standalone` or `--module` per project.
Standalone apps bootstrap with `bootstrapApplication`, `app.config.ts` and `app.routes.ts`; the PII,
session and NgRx state libraries also export `providePiiMask()`, `provideSessionTimeout()` and
`provide<Name>State()`.

`pstack upgrade standalone --all` moves an existing NgModule workspace with Angular's own schematic
(Angular 15.2+): convert, prune the NgModules, then `bootstrapApplication`, with a build and lint
check and one commit per step. It keeps the CSP nonce import first in `main.ts` and, on Angular 21,
zone.js change detection. A last step swaps the root routing module for `provideRouter(routes)`
(in `app.routes.ts`) and drops `BrowserModule`; on an already converted workspace it runs alone.
`--project=a,b` limits it to some projects; `--dry-run` shows the plan.
Ionic apps keep `IonicModule`; Ionic's own codemod moves them to Ionic's standalone components.

## What you get

- **Generators** for apps (Angular, Ionic, Flutter), shared libraries (TypeScript, Angular, Ionic,
  Flutter, assets, styles, state, design tokens, session timeout, PII masking) and environments.
- **Release builds** per environment with:
  - env value encryption (AES-GCM),
  - a strict Content Security Policy with per-request nonces, plus `.htaccess` and `nginx.conf`
    written from an allowlist,
  - Subresource Integrity for every chunk,
  - build-provenance meta, EXIF stripping, leak checks, source-map control, comment and console
    stripping, and optional obfuscation.
- **Migration** of existing projects into the workspace: standalone Angular CLI, Ionic/Capacitor and
  Flutter apps, multi-project Angular CLI repos, Nx 14–22 workspaces and npm/Yarn/pnpm workspaces —
  with rollback.
- **Repo infrastructure**: docs, CI gates (affected lint/test/build, dependency cycles, type checks),
  quality checks and a scheduled dependency-upgrade workflow.
- **AI assistant context**: a generated workspace summary in `CLAUDE.md`, `AGENTS.md` and
  `.github/copilot-instructions.md`, refreshed as apps and libraries are added.

## Commands

| Command                                  | What it does                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pstack new <dir>`                       | Create a workspace (installs dependencies, initialises git)                                |
| `pstack update`                          | Upgrade the workspace's plugin and run its migrations                                      |
| `pstack upgrade angular`                 | Move the workspace to the next Angular major (one commit per step)                         |
| `pstack upgrade nx`                      | Move an Nx 15 or 16 workspace to Nx 17 (Angular unchanged)                                 |
| `pstack upgrade standalone`              | Move NgModules to standalone components (one commit per mode)                              |
| `pstack app` / `pstack lib`              | Add an application or a shared library                                                     |
| `pstack env`                             | Add an environment to some or all apps                                                     |
| `pstack migrate`                         | Copy an existing project into the workspace (the source is never modified)                 |
| `pstack adopt`                           | Move apps that build with the repo's own scripts to the release target, compare the builds |
| `pstack build`                           | Build every app (or some) for one environment                                              |
| `pstack csp`                             | Edit an app's CSP allowlist and write its server config                                    |
| `pstack hardening` / `pstack encryption` | Show or change release hardening and env encryption                                        |
| `pstack assets strip-exif`               | Remove EXIF, XMP and IPTC from the source images apps ship (`--check` lists them)          |
| `pstack infra`                           | Add repo docs, CI gates, quality checks and the upgrade workflow                           |
| `pstack llm`                             | Refresh the AI assistant context files                                                     |

Run `pstack --help` for every option. The full guide is the **[user manual](USER-MANUAL.md)**.

## Using it as an Nx plugin

```bash
# pin @nx/devkit to the workspace's nx version (17-22), e.g. @nx/devkit@17.0.6
npm i -D --save-exact @mouryaamit/nx-polystack @nx/devkit@17.0.6
npx nx list @mouryaamit/nx-polystack
npx nx g @mouryaamit/nx-polystack:app --type=angular --name=portal
```

## Phase 1 – runtime only

An Angular 15 app that is not in a pstack workspace yet (a plain Angular CLI repo) can use the CSP
nonce runtime on its own. It needs no `nx.json` and no workspace config, and the install brings in
no Nx and runs no install scripts (only `tslib` comes with it):

```bash
npm i -E @mouryaamit/nx-polystack@1.24.0      # or the team's git copy, e.g. "<package>@git+https://…#dist-v1.24.0"
```

First line of `src/main.ts` (a renamed copy uses its own package name):

```ts
import '@mouryaamit/nx-polystack/runtime/csp-nonce';
```

It gives the page nonce to the `<style>`, `<script>` and `<link rel="stylesheet">` elements that
Angular 15 and webpack add at runtime (inserted via `appendChild`, `insertBefore`, `append`, … on
the document, elements and shadow roots). Runtime 1.24.0 behaves the same as the 1.2.2 runtime
(the file is unchanged apart from the warning below).

**Server side.** The nonce must be new on every response, and the same value must appear in the CSP
header and in `index.html`:

- `<meta property="csp-nonce" content="…">` in `<head>` (preferred: the runtime reads it even
  when an inline script is not allowed), or an inline
  `<script nonce="…">window.__cspNonce = '…';</script>` before the app's scripts. The runtime
  reads `window.__cspNonce` first, then the meta tag (`property="csp-nonce"` or `name="csp-nonce"`).
- `nonce="…"` on every `<script>`, `<link rel="stylesheet">` and `<style>` in the built
  `index.html`. Angular 15 does not add these; pstack's release build does, and outside a workspace
  the app's own post-build step must (for example one that writes the SSI directive below).

With Apache, mod_include (SSI) fills the value. In `index.html` (single quotes inside the
directive, so an unprocessed directive cannot end the double-quoted attribute):

```html
<meta property="csp-nonce" content="<!--#echo var='CSP_NONCE' -->" />
<script src="main.js" type="module" nonce="<!--#echo var='CSP_NONCE' -->"></script>
```

`.htaccess` next to `index.html` (needs `mod_rewrite`, `mod_headers`, `mod_include`,
`mod_unique_id` and `mod_setenvif`, and `AllowOverride FileInfo Options=IncludesNOEXEC` for the
folder). This is what `pstack csp` writes, reduced to the CSP parts:

```apache
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^ index.html [L]

# Per-request nonce: UNIQUE_ID without "@" (not allowed in a nonce). reqenv() reads the
# environment only, so request headers cannot set it. Repeat the second line 8 times in all.
SetEnvIfExpr "reqenv('UNIQUE_ID') =~ /^(.+)$/" CSP_NONCE=$1
SetEnvIfExpr "reqenv('CSP_NONCE') =~ /^([^@]*)@(.*)$/" CSP_NONCE=$1_$2

Options +IncludesNOEXEC
<Files "index.html">
    SetOutputFilter INCLUDES
    Header always set Cache-Control "no-store"
</Files>

Header always set Content-Security-Policy "script-src 'self' 'nonce-%{CSP_NONCE}e' 'strict-dynamic'; style-src 'self' 'nonce-%{CSP_NONCE}e'; object-src 'none'; base-uri 'self'"
```

**When the value is not filled in.** A value that is not a real nonce (the SSI directive left as
is, Apache's `(none)` for an unset variable, or a placeholder such as `random-csp-nonce`) counts as
no nonce: nothing is patched, so runtime styles and scripts are blocked. Since 1.24.0 the runtime
then logs one console warning, `[pstack csp-nonce] The CSP nonce was not filled in …`. No value at
all (e.g. `ng serve` without a CSP) stays silent. If the server fills nothing, the browser usually
blocks the app's own scripts first (their `nonce` attributes are unfilled too, and Angular 16+
copies `ngCspNonce` onto its script tags), so the runtime never runs: the browser's CSP errors
are then the signal.

## Style attributes under a strict CSP: runtime/csp-style-attr (opt-in, 1.24.0)

Under `style-src` without `'unsafe-inline'`, `element.setAttribute('style', …)` is blocked
(`style-src-attr`), but the same declarations written through the CSSOM (`element.style.cssText`)
are allowed. Angular writes static `style="…"` in templates, host styles and `[attr.style]` with
`setAttribute('style')`, and so do libraries (NgbModal backdrop, NgbTooltip, NgbPopover,
ngx-extended-pdf-viewer). This opt-in runtime routes those writes to the CSSOM. Angular 15–21 need
it (Angular 21 for the NgbModal backdrop and NgbPopover). Import it right after the nonce runtime:

```ts
import '@mouryaamit/nx-polystack/runtime/csp-nonce';
import '@mouryaamit/nx-polystack/runtime/csp-style-attr';
```

It replaces `Element.prototype.setAttribute` and `setAttributeNS` so that only
`setAttribute('style', v)` (any case) and `setAttributeNS(null, 'style', v)` become
`el.style.cssText = v`; every other attribute and namespace goes to the original method. It does
not depend on the nonce. Angular 21's builder warns that the two runtime files are not ESM; that is
harmless (they are side-effect-only scripts), and `allowedCommonJsDependencies` silences it.

Conditions of use (any change to the patch needs a new security review):

- **F1 – no user-controlled data** in `[attr.style]`, `[style]`, `[ngStyle]` or
  `setAttribute('style', …)`. The patch lifts the CSP block on these writes, so CSS from user input
  would be applied (CSS injection: overlays, data exfiltration through `url()`).
- **F2 – no CSP reports for these writes.** They no longer raise `securitypolicyviolation` events
  or reports. Keep CSP reporting on for everything else.
- **F3 – only `setAttribute` / `setAttributeNS` are patched.** `setAttributeNode`,
  `attributes.setNamedItem` and `Attr.value` still set the attribute and stay blocked.
- **F4 – `getAttribute('style')` returns normalised text.** The browser's serialisation is
  returned, not the string written, and declarations the browser does not support are dropped
  (`'color: rgb(0, 0, 255); -x-unknown: 1'` reads back as `'color: rgb(0, 0, 255);'`).
- **F5 – import order and rollback.** Import it right after `runtime/csp-nonce`. To roll back,
  remove the line.

Not covered (still blocked by `style-src-attr`): `style="…"` in markup parsed by the HTML parser,
i.e. `innerHTML`, `insertAdjacentHTML`, `[innerHTML]` content and static `index.html` markup
(for example ngx-extended-pdf-viewer's thumbnails, one report per page, which it builds with `innerHTML`).
Static `style="…"` written in Angular templates is not parser markup: Angular sets it with
`setAttribute`, so it is covered. Trusted Types and inline event handlers
(`setAttribute('onclick', …)`) are unaffected.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
