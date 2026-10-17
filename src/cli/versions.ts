import { DEV_GITHUB_REPO, installSource } from './install-source';
import { CliError } from './types';

export const PLUGIN_NAME = '@mouryaamit/nx-polystack';
/** owner/repo of the private development repo on GitHub. */
export const PLUGIN_GITHUB_REPO = DEV_GITHUB_REPO;
/** Earlier names of the repo; workspaces pinned to them are still recognised (v0.38.2). */
export const LEGACY_GITHUB_REPOS = ['mouryaamit/nx-polystack'];

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** npm forms of a version pin: exact, ^, ~ or = (the lower bound is the pinned version). */
const NPM_SPEC = /^[\^~=]?v?(\d+\.\d+\.\d+)$/;

/** Git-tag specs npm may save for the plugin's repos (".git" optional). */
function gitSpec(): RegExp {
  const source = installSource();
  const repos = new Set([PLUGIN_GITHUB_REPO, ...LEGACY_GITHUB_REPOS]);
  if (source.kind === 'github') repos.add(source.repo);
  const path = `(?:${[...repos].map(escapeRegExp).join('|')})`;
  return new RegExp(
    `^(?:github:|git\\+https://github\\.com/|git\\+ssh://git@github\\.com/)?${path}(?:\\.git)?#v(\\d+\\.\\d+\\.\\d+)$`,
  );
}

export function normalizeVersion(v: string): string {
  const m = SEMVER.exec(v.trim());
  if (!m) {
    throw new CliError(`"${v}" is not a valid version (expected x.y.z).`);
  }
  return `${m[1]}.${m[2]}.${m[3]}`;
}

export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split('.').map(Number);
  const pb = normalizeVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/** The pin `pstack new` / `pstack update` write: a git tag of the repo, or an exact npm version. */
export function formatPluginSpec(version: string): string {
  const v = normalizeVersion(version);
  const source = installSource();
  return source.kind === 'npm' ? v : `github:${source.repo}#v${v}`;
}

/** Extra `npm install` flags for a pin, so npm saves it as formatPluginSpec wrote it. */
export function pinInstallFlags(): string[] {
  return installSource().kind === 'npm' ? ['--save-exact'] : [];
}

/**
 * The pinned version, or null when the spec is neither a tag of the plugin repo (github:,
 * git+https, git+ssh or owner/repo form; earlier repo names too) nor an npm version (x.y.z,
 * ^x.y.z, ~x.y.z or =x.y.z).
 */
export function parsePluginSpec(spec: string): string | null {
  const s = spec.trim();
  const m = gitSpec().exec(s) ?? NPM_SPEC.exec(s);
  return m ? m[1] : null;
}

/**
 * Shell command that installs the global CLI.
 * - npm source: `npm i -g <package>@<version>`.
 * - GitHub source: the prebuilt release asset. Not `npm i -g github:…#vX`: npm prepares git deps
 *   of a global install in global mode, so devDependencies (typescript) are missing and the
 *   build fails. Not the release download URL: the repo is private, and npm can't authenticate
 *   to GitHub; `gh` downloads with the user's GitHub login.
 */
export function globalInstallCommand(version: string): string {
  const v = normalizeVersion(version);
  const source = installSource();
  if (source.kind === 'npm') return `npm i -g ${PLUGIN_NAME}@${v}`;
  const asset = `mouryaamit-nx-polystack-v${v}.tgz`;
  return (
    `gh release download v${v} -R ${source.repo} -p ${asset} -D /tmp --clobber` +
    ` && npm i -g /tmp/${asset}`
  );
}
