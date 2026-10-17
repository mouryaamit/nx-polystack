import { TargetConfiguration, Tree, writeJson } from '@nx/devkit';

import type { KeySplit } from '../../lib/env-encryption/gcm';
import { POLYSTACK_BUILD_EXECUTOR } from '../../lib/utils/angular-project';
import { findProjects } from '../../lib/utils/llm-block';
import { flagBoolean, Flags, flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const CHANGE_FLAGS = [
  'mode',
  'addKey',
  'removeKey',
  'addPublic',
  'removePublic',
  'metaName',
  'timezone',
  'stampFormat',
  'format',
  'profileFiles',
  'cipher',
  'keySources',
];
/** Options of one app's release target (need --app). */
const APP_FLAGS = ['keySplit', 'domains', 'includeWww', 'onMismatch'];

/** aes-gcm always writes ENC2(…); format only applies to cryptojs. */
function cipherLine(cfg: Record<string, unknown>): string {
  if (cfg['cipher'] === 'aes-gcm') return '  cipher      aes-gcm (values written as ENC2(…))';
  const enc = cfg['format'] === 'enc' ? ' (values written as ENC(…))' : '';
  return `  cipher      ${cfg['cipher']} · format ${cfg['format']}${enc}`;
}

/** Text of the settings for `pstack encryption` with no flags. */
export function describeEnvEncryption(cfg: Record<string, unknown>, source: string): string {
  const keys = cfg['keys'] as Record<string, string[]>;
  const stamp = cfg['stamp'] as Record<string, string> | undefined;
  const lines = [
    `Env encryption (${source}):`,
    `  mode        ${cfg['mode']}${
      cfg['mode'] === 'listed'
        ? ' (listed keys are encrypted)'
        : ' (every field except publicKeys is encrypted)'
    }`,
    cipherLine(cfg),
    `  keySources  ${(cfg['keySources'] as string[]).join(', ')}${
      cfg['cipher'] === 'aes-gcm'
        ? ' (plus the internal per-build key)'
        : ` (cryptojs uses the commit, from <meta name="${cfg['metaName']}">)`
    }`,
    `  keys        ${Object.entries(keys)
      .map(([p, k]) => `${p}: ${k.join(', ') || '—'}`)
      .join(' · ')}`,
    `  publicKeys  ${(cfg['publicKeys'] as string[]).join(', ') || '—'}`,
    `  profiles    ${(cfg['profileFiles'] as string[]).join(', ') || '—'}`,
    stamp
      ? `  stamp       ${stamp['timeField']} / ${stamp['branchField']} · ${stamp['timezone']} · ${stamp['format']}`
      : '  stamp       off',
  ];
  return lines.join('\n');
}

export async function runEncryption(ctx: CommandContext): Promise<number> {
  const root = requireWorkspace(ctx.cwd, 'encryption');
  const { normalizeEnvEncryption, DEFAULT_STAMP } = await import('../../lib/env-encryption/config');
  const { readEnvEncryptionBlock, writeEnvEncryptionBlock, initialEnvEncryption } = await import(
    '../../lib/env-encryption/workspace'
  );
  const { newSalt, SALT_FILE } = await import('../../lib/env-encryption/key-material');
  const { normalizeHosts } = await import('../../lib/env-encryption/domains');
  const { KEY_SPLITS } = await import('../../lib/env-encryption/gcm');
  const { customKeyNote, switchAppsToGcm } = await import('../../lib/env-encryption/switch-gcm');
  const changing = [...CHANGE_FLAGS, ...APP_FLAGS, 'rotateSalt'].some(
    (f) => ctx.flags[f] !== undefined,
  );
  for (const f of [...CHANGE_FLAGS, 'app', 'keySplit', 'domains', 'onMismatch']) {
    if (ctx.flags[f] === true) {
      throw new CliError(`--${f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a value.`);
    }
  }
  const project = flagString(ctx.flags, 'project') ?? 'default';

  let shown = '';
  const notes: string[] = [];
  await runInTree(root, { ...ctx, quietWhenUnchanged: !changing }, (tree) => {
    const raw = readEnvEncryptionBlock(tree);
    let cfg;
    try {
      cfg = raw === undefined ? initialEnvEncryption(tree) : normalizeEnvEncryption(raw);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    const source =
      raw === undefined ? 'not set yet; run "pstack update" or change a setting' : 'nx.json';
    if (!changing) {
      shown = describeEnvEncryption(cfg as unknown as Record<string, unknown>, source);
      return;
    }
    const mode = flagString(ctx.flags, 'mode');
    if (mode !== undefined) cfg.mode = mode as typeof cfg.mode;
    const keys = new Set(cfg.keys[project] ?? (project === 'default' ? [] : cfg.keys['default']));
    for (const k of list(flagString(ctx.flags, 'addKey'))) keys.add(k);
    for (const k of list(flagString(ctx.flags, 'removeKey'))) keys.delete(k);
    if (ctx.flags['addKey'] !== undefined || ctx.flags['removeKey'] !== undefined) {
      cfg.keys = { ...cfg.keys, [project]: [...keys] };
    }
    const pub = new Set(cfg.publicKeys);
    for (const k of list(flagString(ctx.flags, 'addPublic'))) pub.add(k);
    for (const k of list(flagString(ctx.flags, 'removePublic'))) pub.delete(k);
    cfg.publicKeys = [...pub];
    const valueFormat = flagString(ctx.flags, 'format');
    if (valueFormat !== undefined) cfg.format = valueFormat as typeof cfg.format;
    const profileFiles = flagString(ctx.flags, 'profileFiles');
    if (profileFiles !== undefined) cfg.profileFiles = list(profileFiles);
    const metaName = flagString(ctx.flags, 'metaName');
    if (metaName !== undefined) cfg.metaName = metaName;
    const timezone = flagString(ctx.flags, 'timezone');
    const format = flagString(ctx.flags, 'stampFormat');
    if (timezone !== undefined || format !== undefined) {
      cfg.stamp = {
        ...DEFAULT_STAMP,
        ...(cfg.stamp ?? {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(format !== undefined ? { format } : {}),
      };
    }
    const cipher = flagString(ctx.flags, 'cipher');
    if (cipher !== undefined) cfg.cipher = cipher;
    const sources = flagString(ctx.flags, 'keySources');
    if (sources !== undefined) cfg.keySources = list(sources) as typeof cfg.keySources;
    if (ctx.flags['rotateSalt'] !== undefined && flagBoolean(ctx.flags, 'rotateSalt')) {
      tree.write(SALT_FILE, newSalt());
      notes.push(`${SALT_FILE} rotated; commit it (builds after this use the new salt).`);
    }
    const app = flagString(ctx.flags, 'app');
    if (APP_FLAGS.some((f) => ctx.flags[f] !== undefined)) {
      if (!app) {
        throw new CliError(
          '--key-split, --domains, --include-www and --on-mismatch need --app=<project>.',
        );
      }
      setAppOptions(tree, app, ctx.flags, KEY_SPLITS, normalizeHosts);
      if (cfg.cipher !== 'aes-gcm') {
        notes.push(
          'These app options take effect with cipher aes-gcm (pstack encryption --cipher=aes-gcm).',
        );
      }
    }
    try {
      writeEnvEncryptionBlock(tree, cfg);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    if (cipher === 'aes-gcm') {
      notes.push(...switchAppsToGcm(tree, cfg.publicKeys, cfg));
    } else if (
      sources !== undefined &&
      cfg.cipher === 'aes-gcm' &&
      cfg.keySources.includes('custom')
    ) {
      notes.push(customKeyNote(cfg.metaName));
    }
    shown = describeEnvEncryption(
      normalizeEnvEncryption(cfg) as unknown as Record<string, unknown>,
      'nx.json',
    );
  });
  console.log(shown);
  for (const n of notes) console.log(`Note: ${n}`);
  if (flagString(ctx.flags, 'metaName') !== undefined) {
    console.log(
      'Note: apps that read the key from the meta tag must use the new name too (pass it as ' +
        'metaName to envReady of runtime/env-secret).',
    );
  }
  return 0;
}

/** Writes --key-split, --include-www, --on-mismatch and --domains into the app's release target. */
function setAppOptions(
  tree: Tree,
  app: string,
  flags: Flags,
  keySplits: KeySplit[],
  normalizeHosts: (hosts: string[]) => string[],
): void {
  // Walks apps/ and libs/ (getProjects needs Nx's native file globbing).
  const found = [...findProjects(tree, 'apps'), ...findProjects(tree, 'libs')].find(
    (p) => (typeof p.json['name'] === 'string' ? p.json['name'] : p.root.split('/').pop()) === app,
  );
  if (!found) throw new CliError(`No project named "${app}".`);
  const targets = (found.json['targets'] ?? {}) as Record<string, TargetConfiguration>;
  const target = Object.values(targets).find((t) => t.executor === POLYSTACK_BUILD_EXECUTOR);
  if (!target) throw new CliError(`"${app}" has no release target (${POLYSTACK_BUILD_EXECUTOR}).`);
  target.options = { ...(target.options ?? {}) };
  const split = flagString(flags, 'keySplit');
  if (split !== undefined) {
    if (!keySplits.includes(split as KeySplit)) {
      throw new CliError(`--key-split must be ${keySplits.join(' or ')}.`);
    }
    target.options.keySplit = split;
  }
  if (flags['includeWww'] !== undefined) {
    target.options.includeWww = flagBoolean(flags, 'includeWww');
  }
  const mismatch = flagString(flags, 'onMismatch');
  if (mismatch !== undefined) {
    if (!['block', 'warn'].includes(mismatch)) {
      throw new CliError('--on-mismatch must be block or warn.');
    }
    target.options.onMismatch = mismatch;
  }
  const domains = flagString(flags, 'domains');
  if (domains !== undefined) {
    // <conf>=<hosts>[;<conf>=<hosts>…]; every entry is checked before any is set.
    const entries = domains
      .split(';')
      .map((e) => e.trim())
      .filter(Boolean);
    const parsed: [Record<string, unknown>, string[]][] = [];
    for (const entry of entries.length > 0 ? entries : ['']) {
      const m = /^([\w-]+)\s*=(.*)$/.exec(entry);
      if (!m) {
        throw new CliError(
          '--domains must be <configuration>=<host,host>[;<configuration>=…] ' +
            '(e.g. uat=a.com,b.in;prod=a.com).',
        );
      }
      const conf = target.configurations?.[m[1]];
      if (!conf) {
        throw new CliError(`The release target of "${app}" has no configuration "${m[1]}".`);
      }
      try {
        parsed.push([conf, normalizeHosts(list(m[2]))]);
      } catch (err) {
        throw new CliError((err as Error).message);
      }
    }
    for (const [conf, hosts] of parsed) {
      if (hosts.length > 0) conf['domains'] = hosts;
      else delete conf['domains'];
    }
  }
  writeJson(tree, `${found.root}/project.json`, found.json);
}
