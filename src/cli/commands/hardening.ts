import { TargetConfiguration, Tree, writeJson } from '@nx/devkit';

import {
  CHECK_MODES,
  checkObfuscateOptions,
  CONSOLE_METHODS,
  OBFUSCATE_MODES,
} from '../../lib/hardening/options';
import { POLYSTACK_BUILD_EXECUTOR } from '../../lib/utils/angular-project';
import {
  ensureObfuscationDependencies,
  ensureReleaseHardeningDependencies,
} from '../../lib/utils/dependencies';
import { findProjects } from '../../lib/utils/llm-block';
import { flagBoolean, Flags, flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

type Options = Record<string, unknown>;

const STRING_FLAGS = ['obfuscate', 'obfuscateOptions', 'leakCheck', 'sourceMaps', 'dropConsole'];
const BOOLEAN_FLAGS = ['sri', 'stripComments'];
const OPTION_FLAGS = [...STRING_FLAGS, ...BOOLEAN_FLAGS];

const dashed = (f: string) => `--${f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const isDev = (conf: Options) => String(conf['env'] ?? '').toUpperCase() === 'DEV';

/** One configuration's effective hardening options (target options under configuration ones). */
function describeConfiguration(name: string, conf: Options, defaults: Options): string {
  const label = name.padEnd(6);
  if (isDev({ ...defaults, ...conf })) return `  ${label}DEV: no hardening steps run`;
  const o = { ...defaults, ...conf };
  const drop = Array.isArray(o['dropConsole']) ? (o['dropConsole'] as string[]) : [];
  return (
    `  ${label}leakCheck ${o['leakCheck'] ?? 'off'} · sourceMaps ${o['sourceMaps'] ?? 'off'} · ` +
    `stripComments ${o['stripComments'] === true} · dropConsole ${drop.join(',') || '—'} · ` +
    `obfuscate ${o['obfuscate'] ?? 'off'}${overridesText(o['obfuscateOptions'])} · ` +
    `sri ${o['sri'] === true}`
  );
}

const overridesText = (v: unknown) =>
  v && typeof v === 'object' && Object.keys(v).length > 0 ? ` ${JSON.stringify(v)}` : '';

/** The changes the flags ask for, validated before anything is written. */
function requestedOptions(flags: Flags): Options {
  const set: Options = {};
  const obfuscate = flagString(flags, 'obfuscate');
  if (obfuscate !== undefined) {
    if (!(OBFUSCATE_MODES as readonly string[]).includes(obfuscate)) {
      throw new CliError(`--obfuscate must be ${OBFUSCATE_MODES.join(', ')}.`);
    }
    set['obfuscate'] = obfuscate;
  }
  const overrides = flagString(flags, 'obfuscateOptions');
  if (overrides !== undefined) {
    if (overrides.trim() === 'none') {
      set['obfuscateOptions'] = undefined;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(overrides);
      } catch {
        throw new CliError(
          '--obfuscate-options must be JSON, e.g. \'{"stringArrayThreshold":0.3}\' (none: clear).',
        );
      }
      try {
        set['obfuscateOptions'] = checkObfuscateOptions(parsed);
      } catch (err) {
        throw new CliError((err as Error).message);
      }
    }
  }
  for (const key of ['leakCheck', 'sourceMaps']) {
    const value = flagString(flags, key);
    if (value === undefined) continue;
    if (!(CHECK_MODES as readonly string[]).includes(value)) {
      throw new CliError(`${dashed(key)} must be fail, warn or off.`);
    }
    set[key] = value;
  }
  const drop = flagString(flags, 'dropConsole');
  if (drop !== undefined) {
    const methods =
      drop.trim() === 'none'
        ? []
        : drop
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean);
    for (const m of methods) {
      if (!(CONSOLE_METHODS as readonly string[]).includes(m)) {
        throw new CliError(
          `--drop-console: unknown console method "${m}" (use ${CONSOLE_METHODS.join(
            ', ',
          )} or none).`,
        );
      }
    }
    set['dropConsole'] = [...new Set(methods)];
  }
  for (const key of BOOLEAN_FLAGS) {
    if (flags[key] !== undefined) set[key] = flagBoolean(flags, key);
  }
  return set;
}

export async function runHardening(ctx: CommandContext): Promise<number> {
  const root = requireWorkspace(ctx.cwd, 'hardening');
  for (const f of ['app', 'configuration', ...STRING_FLAGS]) {
    if (ctx.flags[f] === true) throw new CliError(`${dashed(f)} needs a value.`);
  }
  const app = flagString(ctx.flags, 'app');
  if (!app) throw new CliError('--app=<project> is required.');
  const changes = requestedOptions(ctx.flags);
  const changing = OPTION_FLAGS.some((f) => ctx.flags[f] !== undefined);
  const only = flagString(ctx.flags, 'configuration');

  const lines: string[] = [];
  const notes: string[] = [];
  await runInTree(root, { ...ctx, quietWhenUnchanged: !changing }, (tree) => {
    const { found, name, target } = releaseTarget(tree, app);
    const configurations = (target.configurations ?? {}) as Record<string, Options>;
    if (only !== undefined && !configurations[only]) {
      throw new CliError(`The release target of "${app}" has no configuration "${only}".`);
    }
    if (changing) {
      const names = only !== undefined ? [only] : Object.keys(configurations);
      const defaults = (target.options ?? {}) as Options;
      const dev = (n: string) => isDev({ ...defaults, ...configurations[n] });
      const chosen = names.filter((n) => only !== undefined || !dev(n));
      if (only !== undefined && dev(only)) {
        notes.push(`${only} is a DEV configuration: release builds run no hardening step for it.`);
      }
      if (chosen.length === 0) throw new CliError(`"${app}" has no non-DEV configuration.`);
      for (const n of chosen) configurations[n] = { ...configurations[n], ...changes };
      writeJson(tree, `${found.root}/project.json`, found.json);
      addDependencies(tree, changes, notes);
      notes.unshift(`Set on ${chosen.join(', ')}.`);
    }
    const shownDefaults = (target.options ?? {}) as Options;
    lines.push(`Release hardening of ${app} (${name}):`);
    for (const [n, conf] of Object.entries(configurations)) {
      lines.push(describeConfiguration(n, conf, shownDefaults));
    }
  });
  for (const l of lines) console.log(l);
  for (const n of notes) console.log(`Note: ${n}`);
  return 0;
}

/** Workspace packages the new settings load at build time (installed by the user's npm install). */
function addDependencies(tree: Tree, changes: Options, notes: string[]): void {
  const before = tree.read('package.json', 'utf-8');
  const strips =
    changes['stripComments'] === true ||
    (Array.isArray(changes['dropConsole']) && changes['dropConsole'].length > 0);
  if (strips) ensureReleaseHardeningDependencies(tree);
  const level = changes['obfuscate'];
  if (level !== undefined && level !== 'off') {
    ensureObfuscationDependencies(tree);
    notes.push(
      `obfuscate ${level} rewrites main and the lazy chunks (light ≈ +20% gzip, medium ≈ +67%, ` +
        'strong more on the chunk holding the decrypt code); measure start-up time.',
    );
  }
  if (changes['sri'] === true) {
    notes.push(
      'sri: with cipher aes-gcm the app decrypts nothing while a script on the page has no ' +
        'integrity attribute.',
    );
  }
  if (tree.read('package.json', 'utf-8') !== before) {
    notes.push('package.json devDependencies changed: run npm install.');
  }
}

function releaseTarget(tree: Tree, app: string) {
  // Walks apps/ and libs/ (getProjects needs Nx's native file globbing).
  const found = [...findProjects(tree, 'apps'), ...findProjects(tree, 'libs')].find(
    (p) => (typeof p.json['name'] === 'string' ? p.json['name'] : p.root.split('/').pop()) === app,
  );
  if (!found) throw new CliError(`No project named "${app}".`);
  const targets = (found.json['targets'] ?? {}) as Record<string, TargetConfiguration>;
  const entry = Object.entries(targets).find(([, t]) => t.executor === POLYSTACK_BUILD_EXECUTOR);
  if (!entry) {
    throw new CliError(
      `"${app}" has no release target (${POLYSTACK_BUILD_EXECUTOR}); run "pstack update" first.`,
    );
  }
  const [name, target] = entry;
  target.configurations ??= {};
  return { found, name, target };
}
