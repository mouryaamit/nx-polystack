# @mouryaamit/nx-polystack

An Nx 17 plugin and the `pstack` CLI for monorepos that mix **Angular**, **Ionic + Capacitor** and
**Flutter** apps. It scaffolds workspaces, apps and shared libraries, and wires a hardened release
pipeline into every app, so they are all built the same way.

[![npm](https://img.shields.io/npm/v/@mouryaamit/nx-polystack)](https://www.npmjs.com/package/@mouryaamit/nx-polystack)
[![license](https://img.shields.io/npm/l/@mouryaamit/nx-polystack)](LICENSE)

## Install

```bash
npm i -g @mouryaamit/nx-polystack
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

Requires Node 20 and npm 10+. `pstack new` creates Nx 17 workspaces on Angular 15 or, with
`--angular=16`, Angular 16, and Nx 18 workspaces with `--angular=17`; the plugin itself loads in workspaces on Nx 17 to 22.

## Angular versions

Each release adds one Angular major and keeps every earlier one.

| Angular | Nx     | TypeScript | Ionic | Capacitor | Node | Status                                 |
| ------- | ------ | ---------- | ----- | --------- | ---- | -------------------------------------- |
| 15.2    | 17.0.6 | 4.9        | 7.8   | 5         | 20   | supported                              |
| 16.2    | 17.0.6 | 5.1        | 7.8   | 6         | 20   | supported (1.3.1)                      |
| 17.3    | 18.3.5 | 5.4        | 7.8   | 6         | 20   | supported (1.4.0)                      |
| 18.2    | 19.8   | 5.5        | 8.7   | 7         | 20   | supported (1.5.0)                      |
| 19.2    | 20.8   | 5.8        | 8.7   | 7         | 20   | supported (1.7.0)                      |
| 20.3    | 21.6   | 5.9        | 8.7   | 7         | 20   | supported (1.9.0)                      |
| 21      | 22     | 5.9        | 9     | 8         | 22   | `pstack upgrade angular` only, for now |

Supported means:

- `pstack new --angular=<major>` creates a workspace on that major;
- its apps and libraries generate, build, lint, test and release-build;
- `pstack migrate` brings in standalone Angular CLI and Ionic apps and Nx workspaces of the same major;
- `pstack upgrade angular` moves a workspace there from the previous major.

`pstack upgrade angular` moves a workspace one major at a time, with one commit per step. Each step
pins Nx, TypeScript, the build and lint packages, Ionic, Capacitor and Node. It works up to Angular 21
today. Generators for 21 come in the next release; until then they warn which packages to add.

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
  Flutter apps, multi-project Angular CLI repos, Nx 15–22 workspaces and npm/Yarn/pnpm workspaces —
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
| `pstack app` / `pstack lib`              | Add an application or a shared library                                                     |
| `pstack env`                             | Add an environment to some or all apps                                                     |
| `pstack migrate`                         | Copy an existing project into the workspace (the source is never modified)                 |
| `pstack adopt`                           | Move apps that build with the repo's own scripts to the release target, compare the builds |
| `pstack build`                           | Build every app (or some) for one environment                                              |
| `pstack csp`                             | Edit an app's CSP allowlist and write its server config                                    |
| `pstack hardening` / `pstack encryption` | Show or change release hardening and env encryption                                        |
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

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
