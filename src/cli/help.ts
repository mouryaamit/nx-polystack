import { installSource } from './install-source';
import { globalInstallCommand } from './versions';

export function helpText(version: string): string {
  return `
pstack — @mouryaamit/nx-polystack CLI v${version}

USAGE
  pstack <command> [options]

COMMANDS
  new <dir>   Create a new polystack workspace in <dir> (installs deps, initialises git)
  update      Upgrade this workspace's nx-polystack version and run its migrations
  upgrade     upgrade angular: move the workspace to the next Angular major (Nx, TypeScript,
              build and lint packages, Ionic, Capacitor, Node), one commit per step
              upgrade nx: move an Nx 15 or 16 workspace to Nx 17 (where the plugin loads), one
              major per commit, Angular unchanged
              upgrade standalone: NgModules to standalone components with Angular's schematic,
              one commit per mode
  preset      Bootstrap a workspace root skeleton in the current directory
  app         Scaffold a new application into an existing workspace
  lib         Scaffold a shared library (ts, angular, ionic, flutter, assets, styles,
              state, design-tokens, session, pii)
  env         Add an environment to some or all apps later, copied from an existing one
              (env file, build/serve/release configurations, Flutter env, npm scripts)
  llm         Write or refresh the generated workspace block in CLAUDE.md, AGENTS.md and
              .github/copilot-instructions.md (app/lib/env refresh it automatically)
  migrate     Copy an existing project into the workspace, source never modified: a standalone
              Angular CLI, Ionic/Capacitor or Flutter app (apps/<name>), the apps and libraries
              of a multi-project Angular CLI repo (apps/, libs/), the Angular, Ionic and
              Flutter projects of an Nx 15-22 workspace (same paths, names and aliases), or the
              app and TypeScript library packages of an npm, Yarn or pnpm workspaces repo
              (apps/, libs/)
  adopt       Move the Angular apps that still build with the workspace's own scripts to the
              plugin's release target, in place (base hrefs, nonce and obfuscation read from the
              script, environments/<app>/htaccess.<env>, env encryption, build:<app>:<env>)
  encryption  Show or change the env encryption settings of release builds (nx.json
              pstack.envEncryption)
  build       Build every app (or some) for one environment: release targets of Angular/Ionic
              apps and Flutter build targets, one at a time or --parallel, with a summary
  release     Show or change an app's base href per release configuration
  csp         Edit an app's csp-allowlist.json and write its .htaccess and nginx.conf from it
              (strict CSP with a per-request nonce)
  shared      Wire the shared assets and styles folders (libs/shared/assets, libs/shared/styles)
              into existing Angular/Ionic apps; new apps get them automatically
  hardening   Show or change an app's release hardening (leak check, source maps, comment and
              console stripping, obfuscation, SRI for every chunk)
  inspect     Tell whether a build was made by pstack: reads the build meta of a dist folder,
              an index.html or a URL (tool and versions, env, time, branch, commit)
  infra       Add repo docs, CI gates (affected lint/test/build, dependency cycles), quality
              checks (knip, pre-push audit + secret scan) and a dependency-upgrade workflow

OPTIONS — new / preset
  --npmScope=<scope>           npm scope for the workspace (default: mouryaamit)
  --baseBranch=<branch>        Default git branch (default: master)
  --infra=<parts>              Run pstack infra with these parts: docs,ci,quality,upgrades | all |
                               none (default: all)
  --ci=<providers>             CI for the infra ci part: github-actions | jenkins (comma-separated;
                               default: github-actions)
  --ci-cache, --flutter=<mode>, --upgrade-schedule=<s>, --upgrade-scope=<s>
                               passed to pstack infra
  --llm=<tools>                AI-assistant files, as pstack llm: claude | agents | copilot
                               (codex, openai-gpt → agents; comma-separated)
  --projectDescription=<text>  Short project description
  --angular=<major>            Start on this Angular: 15 | 16 | 17 | 18 | 19 | 20 | 21 (default: Angular 15, added by the
                               first Angular or Ionic app)
  --standalone                 New Angular and Ionic apps and libraries use standalone components
                               (default: NgModules; saved as nx.json pstack.angular.style)
  --skipFormat                 Skip Prettier format pass
  --skip-install               new only — do not run npm install
  --skip-git                   new only — do not initialise git
  --force                      new only — allow creating inside another Nx workspace

OPTIONS — inspect
  pstack inspect <dist folder | index.html | URL>
  --json                       Print the result as JSON (the aes-gcm key share is never shown)
  Exit code 0 when a pstack build meta is found, 1 when not.

OPTIONS — update
  --to=<version>               Target version, also as "pstack update <version>"
                               (default: this CLI's version)
  --allow-dirty                Run with uncommitted changes
  --force                      Allow downgrading
  --run-migration=<a,b>        Run these migrations of the installed plugin again, whatever their
                               version (an update runs only those newer than where it starts);
                               needs v1.8.7+ in the workspace
  --list-migrations            List the installed plugin's migrations with their versions

OPTIONS — upgrade angular
  --to=<major>                 Go up to this Angular major, one step at a time (default: the
                               next major); asks before each further step unless --yes
  --yes                        Do every step up to --to without asking
  --skip-check                 Skip "nx run-many -t build lint" after each step
  --no-commit                  Leave each step's changes uncommitted (with --to, stops after one)
  --dry-run                    Print the steps; change nothing
  Needs a clean git tree and the Node major of the step (Node 22 for Angular 21).

OPTIONS — upgrade standalone (Angular 15.2+)
  --all                        Every Angular app and library with NgModules (schematic over the
                               whole workspace; nx.json pstack.angular.style becomes standalone)
  --project=<a,b>              Only these projects
  --skip-check                 Skip "nx run-many -t build lint" after each mode
  --no-commit                  Leave the first mode uncommitted (one mode only)
  --dry-run                    Print the modes; change nothing
  Modes: convert-to-standalone, prune-ng-modules, standalone-bootstrap (apps that bootstrap a
  module). The CSP nonce import stays first in main.ts; Angular 21 apps keep zone.js.

OPTIONS — upgrade nx
  --to=<major>                 16 or 17 (default 17); one nx migrate per major
  --skip-check                 Skip "nx run-many -t build" after each step
  --no-commit                  Leave the step uncommitted (one step only)
  --dry-run                    Print the steps; change nothing
  Keeps Angular and its packages where they are, the JSON files' layout, and Markdown and binary
  files; nx-polystack comes out of package.json for the steps and goes back with @nx/devkit
  pinned to the new Nx. Needs a clean git tree.

OPTIONS — app
  --type=<type>                App type: angular | ionic | flutter  (required)
  --name=<name>                Application name (required)
  --dir=<path>                 Put the app in apps/<path>/<name> (v0.17.0+)
  --tags=<tags>                Comma-separated Nx tags
  --cspConnectSrc=<url>        Angular/Ionic — pre-fill CSP connect-src in csp-allowlist.json
  --appId=<id>                 Ionic only — Capacitor appId (default: com.example.<name>)
  --base-href=<path>           Base href of the uat and prod release configurations, e.g. /portal/
  --port=<n>                   Dev-server port (default: the lowest free port from 4200)
  --env-layout=<layout>        Angular/Ionic — default (environment.ts for dev) | per-env
                               (environment.dev|uat|prod.ts replacing environments/environment.ts)
  --standalone | --module      Angular/Ionic — standalone components (app.config.ts,
                               bootstrapApplication) or NgModules (default: the workspace's style)
  --from=<app>                 Create the app from an existing one: copy, rename, every env value
                               emptied; asks for name, folder, port, base href, appId, envs, CSP
                               and tags in a terminal (v1.2.0+)
  --envs=<a,b>                 With --from: environments to keep (dev is always kept)
  --csp=keep|clear             With --from: the base app's CSP allowlist
  --base-href=none             With --from: no base href
  --yes                        With --from: no questions (flags and defaults)

OPTIONS — shared (--app or --all required)
  --app=<a,b>                  Angular/Ionic apps to wire
  --all                        Every Angular/Ionic app

OPTIONS — lib
  --type=<type>                Lib type (required): ts | angular | ionic | flutter | assets | styles |
                               state | design-tokens | session (idle/session timeout) |
                               pii (masking pipe and directive)
  --name=<name>                Library name, kebab-case (required)
  --scope=<scope>              Folder under libs/ and project-name prefix
                               (default: shared; ionic → ionic; flutter → flutter)
  --dir=<path>                 Put the lib in libs/<scope>/<path>/<name> (at most 2 folders; v0.19.0+)
  --variant=<variant>          angular/ionic: internal | buildable | publishable
                               (default: buildable)
                               state: simple-service | ngrx (default: simple-service; always buildable)
  --prefix=<prefix>            angular/ionic: component selector prefix (default: lib)
  --standalone | --module      angular/ionic/pii/session/state: standalone components and
                               provide*() functions, or NgModules (default: the workspace's style)
  --tags=<tags>                Comma-separated extra Nx tags

OPTIONS — env
  --name=<name>                Environment slug, e.g. qa, sit, staging (required)
  --app=<a,b> | --all          Apps to add it to (one of them is required)
  --from=<env>                 Environment to copy (default uat); secret values become
                               \${APP_ENV_KEY} placeholders filled at build time
  --api-url=<url>              API base URL of the new environment
  --production[=false]         production flag of the new Angular env file (default: as --from)
  --base-href=<path>           Base href of the new configuration (default: as --from)
  --domains=<hosts>            aes-gcm domain lock of the new release configuration

OPTIONS — encryption (no options: show the settings)
  --mode=<mode>                listed (encrypt the listed keys) | all (every field except publicKeys)
  --add-key=<keys>             Add keys to encrypt in listed mode (comma-separated)
  --remove-key=<keys>          Remove keys
  --project=<env project>      Keys of this env project (default: default)
  --add-public=<keys>          Keys kept in plain text in mode all
  --remove-public=<keys>       Remove public keys
  --format=<format>            raw | enc (values written as ENC(…), read by runtime/env-secret)
  --profile-files=<files>      Files next to the env file whose sensitive fields are encrypted
                               (e.g. app.profile.ts; empty value clears)
  --meta-name=<name>           Meta tag carrying the build info and key (default: x-build)
  --timezone=<tz>              Build stamp time zone, e.g. Asia/Kolkata (default: UTC)
  --stamp-format=<format>      Build stamp format (default: DD MMM YYYY hh:mm:ss A z)
  --cipher=<cipher>            cryptojs (default) | aes-gcm (Web Crypto; main.ts awaits envReady)
  --key-sources=<list>         aes-gcm key factors besides the internal per-build key: commit,
                               salt, env (PSTACK_ENV_KEY), custom (PSTACK_CUSTOM_KEY + getKey).
                               salt and env values ship in the bundle like the commit: use a
                               dedicated random value, never a real secret; only custom stays out
  --rotate-salt                New tools/config/env-salt
  --app=<project>              App whose release target gets the options below
  --key-split=<split>          meta-bundle (default) | meta-bundle-asset
  --domains=<conf>=<hosts>     Hosts the build may run on, per configuration, separated by ;
                               e.g. uat=a.com,b.in;prod=a.com (uat= removes the list)
  --include-www=<bool>         example.com also allows www.example.com (default: true)
  --on-mismatch=<mode>         block (default) | warn

OPTIONS — llm
  --providers=<list>           claude | agents | copilot, comma-separated (default: all three;
                               codex, openai-gpt → agents). Only the text between the
                               nx-polystack markers is managed; the rest of each file is kept.

OPTIONS — migrate
  --source=<path>              Project to migrate: its repo root (required unless --rollback;
                               read only)
  --name=<name>                App name, kebab-case (default: the Angular project name or
                               the pubspec name); for workspace sources the report name
  --adapter=<id>               Skip detection: angular-cli | flutter | nx-workspace | angular-workspace | ionic |
                               npm-workspaces, or an adapter listed in nx.json
  --min-confidence=<n>         Use the best adapter when it reaches n (0.50 to 1.00; default 0.80; v0.15.0+)
  --dir=<path>                 Single-app sources: put the app in apps/<path>/<name> (v0.16.0+)
  --detect                     Print the detection table (adapter, confidence, reasons) and
                               exit; writes nothing, works outside a workspace
  --projects=<a,b>             Workspace sources: projects to migrate (default: every supported one)
  --no-deps                    Workspace sources: only the --projects named, not the libs they import
  --prefix=<p>                 Workspace sources: rename projects to <p>-<name> (aliases kept)
  --force-angular              Migrate even when the workspace and the source use different
                               Angular majors (the report flags it)
  --max-files=<n>              Fail when more than n files would be copied (default: 20000)
  --no-rewrite-imports         Keep the copied imports as they were (v0.21.0+). By default,
                               relative imports into another moved project, imports through the
                               source baseUrl, @nrwl/* packages and relative SCSS paths are
                               rewritten in the copies; the report lists each one
  --new-adapter=<id>           Write a starter adapter tools/migrate/<id>.adapter.ts (with a
                               spec) and list it in nx.json "pstack.migrateAdapters" (v0.22.0+).
                               Listed adapters join detection, --adapter and --config; write
                               them with @mouryaamit/nx-polystack/migrate
  --rollback=<name>            Undo migration <name> (v0.13.0+): removes the files it created and
                               reverts its package.json/tsconfig/nx.json changes; anything edited
                               since is kept and listed in docs/migrations/<name>.rollback.md
  --force                      With --rollback: remove or restore the edited items too
  --config=<file>              Run the migrations listed in a JSON batch file (v0.14.0+), all or
                               nothing: { "defaults": {...}, "migrations": [ { "source": ... } ] };
                               relative sources are resolved from the file's folder; values in
                               the file win over --force-angular / --max-files
  Writes docs/migrations/<name>.md and <name>.manifest.json (for --rollback). Without
  --adapter the most confident adapter is used if its confidence is at least 0.80.

OPTIONS — adopt
  --app=<a,b>                  Only these apps (default: every Angular app without a release target)
  --no-scripts                 Leave the build:<app>:<env> and build:all:<env> npm scripts as they are
  --remove-old-scripts         Delete the old build scripts nothing uses any more (also on its own,
                               after an earlier adopt)
  --compare                    With --app=<app>: build it with the old script at --base (a temporary
                               git worktree) and with its release target, for each env, and compare
  --env=<a,b>                  --compare: only these envs (default: every release configuration)
  --base=<commit>              --compare: the commit before adopt (default HEAD when adopt is not
                               committed yet)
  --old-dir=<path>             --compare with one --env: compare against a build made elsewhere
                               (e.g. a clone of master with its own npm install) instead (v1.8.5)
  --report=<path>              Write the report there (a folder ending in / gets pstack-adopt.md),
                               saved as nx.json pstack.adopt.report for later runs (v1.8.5)
  --no-report                  Write no report (saved the same way)
  --dry-run                    Show the changes without writing them
  Writes docs/migrations/adopt.md unless --report says otherwise; --compare writes
  dist/pstack-compare/<app>/report.md.

OPTIONS — infra
  --with=<parts>               docs | ci | quality | upgrades, comma-separated, or all | none
                               (default: all)
  --ci=<providers>             github-actions | jenkins, comma-separated (default: github-actions);
                               the upgrade workflow is GitHub Actions only
  --ci-cache                   GitHub Actions: cache the Nx cache directory between runs
  --flutter=<mode>             Set up Flutter in CI: auto (when a pubspec.yaml is under apps/ or
                               libs/) | on | off; default auto
  --upgrade-schedule=<when>    weekly (Monday 03:17 UTC) | monthly (1st, 03:17 UTC); default weekly
  --upgrade-scope=<scope>      polystack (pstack update) | nx-minor (also nx migrate within the
                               current Nx major); default polystack
  --lint-staged=warn|block     ESLint on commit: report without blocking (warn, the default of new
                               workspaces) or block on errors
  --force                      Overwrite files that already exist (.husky/pre-push is always
                               appended to, never replaced)
  The quality part also adds typecheck targets (tsc --noEmit) and the import/no-unresolved and
  unused-imports ESLint rules (warnings).
  Existing files are kept and listed; npm scripts and dependencies are only added when missing.

OPTIONS — build
  --env=<env>                  Environment, e.g. uat (configuration name or its env option)
  --all | --projects=<a,b>     Every app, or these
  --exclude=<a,b>              Leave these out
  --parallel=<n>               Builds at once, 1-8 (default 1)
  --continue                   Keep going after a failed build (default: stop)
  --flutter-platforms=<list>   web,android,ios (default web)
  --report=<file.json>         Also write the summary as JSON
  --dry-run                    Show the plan only

OPTIONS — release (--app required; no other options: show the base hrefs)
  --app=<project>              App whose release configurations are shown or changed
  --configuration=<name>       Only this configuration (default: every non-DEV configuration)
  --base-href=<path>|none      Base href, starting and ending with / (none: remove)

OPTIONS — csp (--app required; writes the server files that are missing or were written by it)
  --app=<project>              Angular/Ionic app
  --add=<dir>:<src>[,…]        Add sources, e.g. script-src:https://www.googletagmanager.com
  --remove=<dir>:<src>[,…]     Remove sources
  --env=<env>                  --add/--remove change that release env's sources ("envs" in
                               csp-allowlist.json), which only its htaccess.<env> gets
  --import=<file|policy>       Merge an existing policy into csp-allowlist.json: a CSP header value,
                               .htaccess / nginx.conf, or JSON (directive → sources); refused
                               sources ('unsafe-inline', 'unsafe-eval', http:, …) are listed, not
                               imported; paths covered by a host entry are dropped
  --nonce-source=<src>         mod_unique_id (default) or env:<VAR>: a variable the server sets per
                               request (e.g. env:UNIQUE_ID from mod_lua), used as is; also sets the
                               release target's nonce.placeholder
  --force                      Also replace hand-written .htaccess / nginx.conf
  --dry-run                    Show what would change

OPTIONS — hardening (--app required; no other options: show the settings)
  --app=<project>              App whose release target is shown or changed
  --configuration=<name>       Only this configuration (default: every non-DEV configuration)
  --obfuscate=<level>          off | light (≈ +20% gzip) | medium (≈ +67%) | strong (also rc4
                               and control-flow flattening on the decrypt chunk); adds
                               javascript-obfuscator
  --obfuscate-options=<json>   javascript-obfuscator overrides on top of the level, e.g.
                               '{"stringArrayThreshold":0.3}' (none: clear)
  --sri[=false]                Integrity for every chunk; aes-gcm decrypts nothing without it
  --leak-check=fail|warn|off   Plaintext of encrypted env values in the output
  --source-maps=fail|warn|off  .map files or sourceMappingURL comments in the output
  --strip-comments[=false]     Remove comments from the built JS, CSS and index.html
  --drop-console=<methods>     Console calls removed, e.g. log,debug,warn (none: keep all)

GLOBAL FLAGS
  --dry-run, -d                Preview changes without writing files
  --verbose                    Verbose output
  --help,    -h                Show this help
  --version, -v                Print version
  Flag values must use --flag=value (a space-separated value is read as an argument).

Inside a workspace that has its own nx-polystack installed, pstack hands app/lib/env/llm/encryption/hardening/build/release/csp/shared/preset/migrate/infra
to that pinned copy so generated files always match the workspace's plugin version.

INSTALL${
    installSource().kind === 'github' ? ' (needs the GitHub CLI, signed in: gh auth login)' : ''
  }
  ${globalInstallCommand(version)}

EXAMPLES
  pstack new my-workspace --npmScope=acme --ci=github-actions --llm=claude
  pstack app --type=angular --name=portal
  pstack app --type=ionic --name=field-ops --appId=com.acme.fieldops
  pstack app --type=flutter --name=mobile-app --tags=platform:mobile
  pstack app --type=angular --name=portal --dir=legacy
  pstack lib --type=angular --name=ui --variant=publishable
  pstack lib --type=flutter --name=shared-core
  pstack lib --type=state --name=orders --variant=ngrx
  pstack lib --type=design-tokens --name=brand
  pstack lib --type=session --name=session
  pstack lib --type=pii --name=pii-mask
  pstack lib --type=angular --name=ui --dir=forms
  pstack env --name=qa --app=portal --api-url=https://qa.example.com/api
  pstack env --name=sit --all --from=prod --production=false
  pstack llm
  pstack llm --providers=claude,agents
  pstack migrate --source=../legacy-portal --detect
  pstack migrate --source=../legacy-portal --min-confidence=0.6
  pstack migrate --source=../legacy-portal --name=portal --dir=legacy
  pstack migrate --source=../legacy-portal --name=portal
  pstack migrate --source=../field_notes --adapter=flutter --dry-run
  pstack migrate --source=../nx-repo --projects=portal --prefix=legacy
  pstack migrate --rollback=portal --dry-run
  pstack migrate --config=tools/migrations.json --dry-run
  pstack infra
  pstack infra --with=docs,ci --ci=jenkins
  pstack infra --with=upgrades --upgrade-schedule=monthly --upgrade-scope=nx-minor
  pstack infra --with=none --lint-staged=block
  pstack new my-workspace --infra=docs,ci
  pstack build --env=uat --all
  pstack build --env=prod --projects=portal,admin --parallel=2 --continue --report=dist/build.json
  pstack release --app=portal --base-href=/portal/
  pstack app --type=angular --name=portal --base-href=/portal/
  pstack app --type=angular --name=admin --port=4300 --env-layout=per-env
  pstack app --from=web
  pstack app --from=web --name=partner-portal --envs=uat,prod --yes
  pstack shared --all
  nx run portal:clean
  pstack csp --app=portal --add=connect-src:https://api.example.com
  pstack csp --app=portal --import=apps/portal/src/.htaccess --dry-run
  pstack csp --app=portal --env=uat --add=connect-src:https://uat-api.example.com
  pstack hardening --app=portal
  pstack hardening --app=portal --configuration=uat --obfuscate=light --sri
  pstack update
  pstack update 0.3.0 --dry-run
  pstack upgrade angular --dry-run
  pstack upgrade angular --to=18
  pstack upgrade standalone --all --dry-run
  pstack upgrade nx --dry-run
  pstack adopt --compare --app=portal --base=HEAD~1
  pstack adopt --remove-old-scripts --dry-run
`.trimStart();
}
