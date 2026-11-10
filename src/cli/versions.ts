import {
  DEV_GITHUB_REPO,
  InstallSource,
  installSource,
  VERSION_PLACEHOLDER,
} from './install-source';
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
function gitSpec(source: InstallSource): RegExp {
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

/** The spec of a git install source's template, as a pattern capturing the version. */
function templateSpec(source: InstallSource): RegExp | null {
  if (source.kind !== 'git') return null;
  const [before, after] = source.template.split(VERSION_PLACEHOLDER).map(escapeRegExp);
  return new RegExp(`^${before}(\\d+\\.\\d+\\.\\d+)${after}$`);
}

/**
 * A git install source read off a workspace pin: the pin's git URL with `version` in its #ref
 * (once) replaced by {version}, e.g. `git+https://host/org/repo.git#dist-v1.22.0` at 1.22.0. Lets
 * `pstack update` move a renamed copy whose installed version predates git install sources
 * (v1.23.0) along the URL the workspace already uses. Null for any other spec.
 */
export function templateFromPin(spec: string, version: string): InstallSource | null {
  const m = /^(git\+(?:https?|ssh|file):\/\/[^\s#]+#)([^\s#]+)$/.exec(spec.trim());
  if (!m || !/^\d+\.\d+\.\d+$/.test(version) || m[2].split(version).length !== 2) return null;
  return { kind: 'git', template: m[1] + m[2].replace(version, VERSION_PLACEHOLDER) };
}

/**
 * The pin `pstack new` / `pstack update` write: a git tag of the repo, an exact npm version, or
 * the git install source's URL with the version filled in.
 */
export function formatPluginSpec(version: string, source: InstallSource = installSource()): string {
  const v = normalizeVersion(version);
  if (source.kind === 'npm') return v;
  if (source.kind === 'git') return source.template.split(VERSION_PLACEHOLDER).join(v);
  return `github:${source.repo}#v${v}`;
}

/**
 * Dev-only: the plugin spec a new workspace pins instead of formatPluginSpec, from
 * PSTACK_PLUGIN_SPEC (e.g. `file:/path/to/mouryaamit-nx-polystack-vX.tgz`), so a build that has no
 * tag yet can be tested end to end (the Angular release gate). Unset: null.
 */
export function pluginSpecOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const spec = env['PSTACK_PLUGIN_SPEC']?.trim();
  return spec ? spec : null;
}

/** Extra `npm install` flags for a pin, so npm saves it as formatPluginSpec wrote it. */
export function pinInstallFlags(source: InstallSource = installSource()): string[] {
  return source.kind === 'npm' ? ['--save-exact'] : [];
}

/**
 * The pinned version, or null when the spec is neither a tag of the plugin repo (github:,
 * git+https, git+ssh or owner/repo form; earlier repo names too), the git install source's URL,
 * nor an npm version (x.y.z, ^x.y.z, ~x.y.z or =x.y.z).
 */
export function parsePluginSpec(
  spec: string,
  source: InstallSource = installSource(),
): string | null {
  const s = spec.trim();
  const m = templateSpec(source)?.exec(s) ?? gitSpec(source).exec(s) ?? NPM_SPEC.exec(s);
  return m ? m[1] : null;
}

/**
 * Shell command that installs the global CLI.
 * - npm source: `npm i -g <package>@<version>`.
 * - git source: the URL with the version (a prebuilt package: nothing is built on install).
 * - GitHub source: the prebuilt release asset. Not `npm i -g github:…#vX`: npm prepares git deps
 *   of a global install in global mode, so devDependencies (typescript) are missing and the
 *   build fails. Not the release download URL: the repo is private, and npm can't authenticate
 *   to GitHub; `gh` downloads with the user's GitHub login.
 */
export function globalInstallCommand(
  version: string,
  source: InstallSource = installSource(),
  name: string = PLUGIN_NAME,
): string {
  const v = normalizeVersion(version);
  if (source.kind === 'npm') return `npm i -g ${name}@${v}`;
  if (source.kind === 'git') return `npm i -g "${name}@${formatPluginSpec(v, source)}"`;
  const asset = `mouryaamit-nx-polystack-v${v}.tgz`;
  return (
    `gh release download v${v} -R ${source.repo} -p ${asset} -D /tmp --clobber` +
    ` && npm i -g /tmp/${asset}`
  );
}
