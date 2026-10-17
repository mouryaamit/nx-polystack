import * as fs from 'fs';
import * as path from 'path';

/** Where the plugin is installed from: a GitHub repo (git tags + release assets) or npm. */
export type InstallSource = { kind: 'github'; repo: string } | { kind: 'npm' };

const PACKAGE = '@mouryaamit/nx-polystack';
/** The private development repo; also the source when package.json does not say. */
export const DEV_GITHUB_REPO = 'example-org/private-plugin';
const DEFAULT: InstallSource = { kind: 'github', repo: DEV_GITHUB_REPO };

/** `"npm"` or `"github:<owner>/<repo>"` (package.json `pstack.installSource`). */
export function parseInstallSource(value: unknown): InstallSource {
  if (value === undefined) return DEFAULT;
  if (value === 'npm') return { kind: 'npm' };
  const m = typeof value === 'string' ? /^github:([\w.-]+\/[\w.-]+)$/.exec(value) : null;
  if (m) return { kind: 'github', repo: m[1] };
  throw new Error(
    `${PACKAGE}: package.json pstack.installSource must be "npm" or "github:<owner>/<repo>", not ${JSON.stringify(
      value,
    )}.`,
  );
}

/** pstack.installSource from the plugin's own package.json (the first one above `from`). */
export function readInstallSource(from: string = __dirname): InstallSource {
  for (let dir = from; ; ) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg.name === PACKAGE) return parseInstallSource(pkg.pstack?.installSource);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return DEFAULT;
    dir = parent;
  }
}

let current: InstallSource | undefined;

export function installSource(): InstallSource {
  return (current ??= readInstallSource());
}

/** Tests only: pretend to be a build with another install source (undefined: read it again). */
export function setInstallSourceForTests(source: InstallSource | undefined): void {
  current = source;
}
