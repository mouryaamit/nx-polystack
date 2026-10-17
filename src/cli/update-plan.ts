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

/** `npm i -D …` command that pins the plugin at `version` the way pstack update does. */
function pinCommand(version: string): string {
  return ['npm i -D', `${PLUGIN_NAME}@${formatPluginSpec(version)}`, ...pinInstallFlags()].join(
    ' ',
  );
}

export type DepField = 'devDependencies' | 'dependencies';

export interface PluginPin {
  field: DepField;
  version: string;
  /** The spec as written in package.json. */
  spec: string;
  /** An npm range (^x.y.z, ~x.y.z): the installed version may be newer than `version`. */
  range: boolean;
}

export interface UpdateTarget {
  action: 'noop' | 'upgrade' | 'downgrade';
  to: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findPluginPin(pkg: any, example = '0.3.0'): PluginPin {
  for (const field of ['devDependencies', 'dependencies'] as DepField[]) {
    const spec: string | undefined = pkg?.[field]?.[PLUGIN_NAME];
    if (spec === undefined) continue;
    const version = parsePluginSpec(spec);
    if (!version) {
      throw new CliError(
        `${PLUGIN_NAME} is "${spec}" in ${field}. pstack update needs a pinned version — ` +
          `pin one first: ${pinCommand(example)}`,
      );
    }
    return { field, version, spec, range: /^\s*[\^~]/.test(spec) };
  }
  throw new CliError(
    `${PLUGIN_NAME} is not listed in package.json. Add it first: ${pinCommand(example)}`,
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
