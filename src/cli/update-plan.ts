import { InstallSource, installSource } from './install-source';
import { CliError } from './types';
import {
  compareVersions,
  formatPluginSpec,
  globalInstallCommand,
  normalizeVersion,
  parsePluginSpec,
  pinInstallFlags,
  PLUGIN_NAME,
} from './versions';

/** The plugin as a workspace names it: package name and where it is installed from. */
export interface PluginIdentity {
  name: string;
  source: InstallSource;
}

/** This build of the plugin. */
export function selfIdentity(): PluginIdentity {
  return { name: PLUGIN_NAME, source: installSource() };
}

/** `npm i -D …` command that pins the plugin at `version` the way pstack update does. */
function pinCommand(version: string, plugin: PluginIdentity): string {
  const spec = `${plugin.name}@${formatPluginSpec(version, plugin.source)}`;
  return [
    'npm i -D',
    plugin.source.kind === 'git' ? `"${spec}"` : spec,
    ...pinInstallFlags(plugin.source),
  ].join(' ');
}

export type DepField = 'devDependencies' | 'dependencies';

export interface PluginPin {
  field: DepField;
  version: string;
  /** The spec as written in package.json. */
  spec: string;
  /** An npm range (^x.y.z, ~x.y.z): the installed version may be newer than `version`. */
  range: boolean;
  /**
   * The spec names no version pstack recognises (a git tag of another repo, a tarball, a tag such
   * as "latest"); `version` is the installed plugin's version.
   */
  fromInstalled?: boolean;
}

export interface UpdateTarget {
  action: 'noop' | 'upgrade' | 'downgrade';
  to: string;
}

/**
 * The plugin entry of package.json. A spec pstack cannot read a version from falls back to
 * `installed` (the version in node_modules), so `pstack update` can move such a workspace to a
 * normal pin; without an installed copy it is an error.
 */
export function findPluginPin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pkg: any,
  example = '0.3.0',
  installed?: string,
  plugin: PluginIdentity = selfIdentity(),
): PluginPin {
  for (const field of ['devDependencies', 'dependencies'] as DepField[]) {
    const spec: string | undefined = pkg?.[field]?.[plugin.name];
    if (spec === undefined) continue;
    const version = parsePluginSpec(spec, plugin.source);
    if (!version && installed && /^\d+\.\d+\.\d+$/.test(installed)) {
      return { field, version: installed, spec, range: false, fromInstalled: true };
    }
    if (!version) {
      throw new CliError(
        `${plugin.name} is "${spec}" in ${field} and no installed copy was found. ` +
          `pstack update needs a pinned version — pin one first: ${pinCommand(example, plugin)}`,
      );
    }
    return { field, version, spec, range: /^\s*[\^~]/.test(spec) };
  }
  throw new CliError(
    `${plugin.name} is not listed in package.json. Add it first: ${pinCommand(example, plugin)}`,
  );
}

export function resolveTarget(
  from: string,
  toFlag: string | undefined,
  selfVersion: string,
  force: boolean,
): UpdateTarget {
  const to = normalizeVersion(toFlag ?? selfVersion);
  const cmp = compareVersions(to, from);
  if (cmp === 0) return { action: 'noop', to };
  if (cmp < 0 && !force) {
    throw new CliError(
      toFlag === undefined
        ? `the global CLI v${to} is older than the workspace's v${from}. Update it with ` +
          `"${globalInstallCommand(from)}" (or newer), or pass --force to downgrade the workspace.`
        : `v${to} is older than the installed v${from}. Pass --force to downgrade.`,
    );
  }
  return { action: cmp < 0 ? 'downgrade' : 'upgrade', to };
}
