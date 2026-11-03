# Security policy

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this
repository. Do not open a public issue.

Fixes are released for the latest minor version.

## Known advisories in supported dependencies

These advisories have no fix that this plugin can take today. They are listed here so you can judge
them yourself; `npm audit --omit=dev` on this package reports none.

### Nx in your workspace

Nx releases before **22.7.10** have the advisories below. They affect the Nx installed in your
workspace, not code shipped in this package. pstack pins Nx per Angular major: Angular 14–16 on Nx
17.0.6, 17 on 18.3.5, 18 on 19.8.14, 19 on 20.8.4, 20 on 21.6.11, and 21 on 22.7.12. Only the
Angular 21 line has the fixes; there is no patched Nx for the older Angular majors.

| Advisory                                                            | Risk                                 | What to do                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| OS command injection through git refs (`nx affected --base/--head`) | Untrusted branch names               | Pass commit SHAs (`git rev-parse --verify "<ref>^{commit}"`), never ref names from users          |
| Nx daemon and plugin-worker sockets readable by other local users   | Shared build machines                | Set `NX_DAEMON=false` in CI and on shared machines                                                |
| `nx graph` dev server allows any origin (CORS)                      | A website open while `nx graph` runs | Stop `nx graph` when done; do not run it on shared machines                                       |
| Path traversal in `nx migrate` package migrations                   | Malicious packages                   | Run `nx migrate` only for packages you trust (`pstack update` runs only this plugin's migrations) |

CI files that `pstack infra` generates (GitHub Actions `ci.yml`, `Jenkinsfile`) do the first two by
default since 1.13.0, and `pstack update` applies them to CI files it generated earlier. A CI
pipeline you wrote yourself needs the same two changes by hand.

### Development tools of this repository

`minimatch` (glob patterns that expand into very many parts; fixed only in minimatch 11, whose API
the test runner, linter and Nx tooling here do not use) and `deepmerge` (prototype poisoning in
`mergeObject`; no fixed release) come in only through development tools, with patterns and
configuration from this repository itself. They are not part of the published package.

This repository's own tooling runs on Nx 22.7.12. Nx 22 pins `axios`, `follow-redirects` and
`smol-toml` to releases with high-severity advisories, and its `minimatch` brings `brace-expansion`
5 with one; npm `overrides` in `package.json` move all four to fixed releases (none of them is part
of the published package either). CI also runs the tests on Nx 17.0.6, the oldest Nx the plugin
supports, with the table above in mind.

`sharp`, used by release builds to strip image metadata, should be 0.35.5 or newer (`pstack update`
moves existing workspaces there).
