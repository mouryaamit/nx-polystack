import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the plugin is installed from: a GitHub repo (git tags + release assets), npm, or any git
 * URL whose ref names the version (`git+https://host/org/repo.git#dist-v{version}`), for a
 * prebuilt copy of the package kept in another git server (v1.23.0).
 */
export type InstallSource =
  | { kind: 'github'; repo: string }
  | { kind: 'npm' }
  | { kind: 'git'; template: string };

/** The placeholder a git install source's ref holds for the plugin version. */
export const VERSION_PLACEHOLDER = '{version}';
/** git+https, git+http, git+ssh or git+file URL with a #ref (no spaces). */
const GIT_URL = /^git\+(?:https?|ssh|file):\/\/[^\s#]+#[^\s#]+$/;

const PACKAGE = '@mouryaamit/nx-polystack';
/** The private development repo; also the source when package.json does not say. */
export const DEV_GITHUB_REPO = 'example-org/private-plugin';
const DEFAULT: InstallSource = { kind: 'github', repo: DEV_GITHUB_REPO };

/** A git URL template: one {version}, in the #ref. */
function isGitTemplate(value: string): boolean {
  const at = value.indexOf(VERSION_PLACEHOLDER);
  return (
    GIT_URL.test(value) && at > value.indexOf('#') && value.split(VERSION_PLACEHOLDER).length === 2
  );
}

/**
 * `"npm"`, `"github:<owner>/<repo>"` or `"git+<url>#<ref with {version}>"` (package.json
 * `pstack.installSource`).
 */
export function parseInstallSource(value: unknown): InstallSource {
  if (value === undefined) return DEFAULT;
  if (value === 'npm') return { kind: 'npm' };
  const m = typeof value === 'string' ? /^github:([\w.-]+\/[\w.-]+)$/.exec(value) : null;
  if (m) return { kind: 'github', repo: m[1] };
  if (typeof value === 'string' && isGitTemplate(value)) return { kind: 'git', template: value };
  throw new Error(
    `${PACKAGE}: package.json pstack.installSource must be "npm", "github:<owner>/<repo>" or ` +
      `"git+<url>#<ref with ${VERSION_PLACEHOLDER}>", not ${JSON.stringify(value)}.`,
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
