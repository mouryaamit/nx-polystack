# Security policy

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this
repository. Do not open a public issue.

Fixes are released for the latest minor version.

## Known advisories in supported dependencies

These advisories have no fix that this plugin can take today. They are dismissed as tolerable risk
in this repository's Dependabot alerts and listed here so you can judge them yourself.

The plugin targets **Nx 17**. The following are fixed only in Nx 22.7.8 or later and affect the Nx
installed in your workspace, not code shipped in this package. Moving to a newer Nx is on the roadmap.

| Advisory                                                            | Risk                                 | What to do                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Nx daemon and plugin-worker sockets readable by other local users   | Shared build machines                | Set `NX_DAEMON=false` on machines shared with untrusted users                                     |
| OS command injection through git refs (`nx affected --base/--head`) | Untrusted branch names               | Pass only refs from your CI provider; never user-supplied ref names                               |
| `nx graph` dev server allows any origin (CORS)                      | A website open while `nx graph` runs | Stop `nx graph` when done; do not run it on shared machines                                       |
| Path traversal in `nx migrate` package migrations                   | Malicious packages                   | Run `nx migrate` only for packages you trust (`pstack update` runs only this plugin's migrations) |

`braces` (deeply nested patterns) and `sprintf-js` (huge precision specifiers) have no fixed release
yet. Both come in only through development tools (test runner, linters) with patterns and formats
from this repository's own configuration, and are not part of the published package.

`sharp`, used by release builds to strip image metadata, should be 0.35.5 or newer (`pstack update`
moves existing workspaces there).
