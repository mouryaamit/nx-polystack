import * as fs from 'fs';
import * as path from 'path';

import { Tree } from '@nx/devkit';

import {
  DEFAULT_PUBLIC_KEYS,
  DEFAULT_STAMP,
  EnvEncryptionConfig,
  normalizeEnvEncryption,
} from '../../../lib/env-encryption/config';
import {
  closingBracket,
  environmentFields,
  isCodeAt,
  quotedStrings,
  stripComments,
  unescapeString,
} from '../../../lib/env-encryption/env-file';
import {
  readEnvEncryptionBlock,
  writeEnvEncryptionBlock,
} from '../../../lib/env-encryption/workspace';
import { POLYSTACK_BUILD_EXECUTOR } from '../../../lib/utils/angular-project';

/**
 * Sources that encrypt env files with their own script (deny by default, `ENC(...)` values,
 * `PUBLIC_ENV_KEYS`, sensitive fields of `app.profile.ts`) and decrypt them with their own
 * `env-secret.ts`: the workspace's env encryption settings are set to produce the same output, and
 * a known-shape `env-secret.ts` becomes a wrapper of the library runtime module.
 */

const code = (s: string) => `\`${s}\``;
export const RUNTIME_MODULE = '@mouryaamit/nx-polystack/runtime/env-secret';

function readSource(sourceDir: string, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(sourceDir, ...rel.split('/')), 'utf8');
  } catch {
    return undefined;
  }
}

/** Source files under `dir` (relative, POSIX) matching `test`, a few levels deep. */
function findSourceFiles(sourceDir: string, dir: string, test: RegExp, depth = 3): string[] {
  const out: string[] = [];
  const walk = (rel: string, d: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(sourceDir, ...rel.split('/')), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && d > 0 && e.name !== 'node_modules' && !e.name.startsWith('.')) {
        walk(child, d - 1);
      } else if (e.isFile() && test.test(e.name)) out.push(child);
    }
  };
  walk(dir, depth);
  return out.sort();
}

/**
 * The string items of `NAME = [ … ]` in a script (the declaration outside comments and strings).
 * Undefined when it is missing or an item is anything but one plain quoted string.
 */
export function stringArrayConst(text: string, name: string): string[] | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*\\[`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!isCodeAt(text, m.index)) continue;
    const open = m.index + m[0].length - 1;
    const close = closingBracket(text, open);
    if (close < 0) return undefined;
    const body = stripComments(text.slice(open + 1, close));
    const items: string[] = [];
    for (const raw of splitTopLevel(body)) {
      const item = raw.trim();
      if (item === '') continue;
      const strs = quotedStrings(item);
      if (strs.length !== 1 || strs[0].start !== 0 || strs[0].end !== item.length) return undefined;
      items.push(unescapeString(strs[0].content));
    }
    return items;
  }
  return undefined;
}

/** Splits list text at top-level commas (strings kept intact). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let last = 0;
  let depth = 0;
  const strings = quotedStrings(body);
  let si = 0;
  for (let i = 0; i < body.length; i++) {
    while (si < strings.length && strings[si].end <= i) si++;
    if (si < strings.length && strings[si].start <= i && i < strings[si].end) {
      i = strings[si].end - 1;
      continue;
    }
    const c = body[i];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(body.slice(last));
  return parts;
}

export interface SourceEnvEncryption {
  script: string;
  /**
   * listed: the script encrypts only the fields it names (`ENCRYPTED_ENV_KEYS = [...]`), raw
   * CryptoJS ciphertext keyed by the commit; all (default): deny by default, `ENC(...)` values.
   */
  mode?: 'listed' | 'all';
  /** listed: the fields it encrypts. */
  keys?: string[];
  publicKeys: string[];
  profileFiles: string[];
  timeField?: string;
  branchField?: string;
  /** Set by applySourceEnvEncryption when the workspace settings were changed to match. */
  applied?: boolean;
}

/**
 * The fields a listed-mode script encrypts: CryptoJS AES with the commit as passphrase, the
 * field names in one `<NAME>_KEYS = [ ... ]` list. Undefined for any other script.
 */
function listedKeys(text: string): string[] | undefined {
  if (!/\bAES\.encrypt\s*\(/.test(text)) return undefined;
  const names = [...text.matchAll(/\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*KEYS)\s*=\s*\[/g)].map(
    (m) => m[1],
  );
  // A PUBLIC_* list names what stays plain: never read it as the keys to encrypt.
  const lists = names
    .filter((n) => !/^PUBLIC/.test(n))
    .map((n) => stringArrayConst(text, n))
    .filter((l): l is string[] => !!l);
  return lists.length === 1 && lists[0].length > 0 ? lists[0] : undefined;
}

/** The source's own env encryption, when it has the known shape. */
export function detectSourceEnvEncryption(
  sourceDir: string,
): SourceEnvEncryption | { unreadable: string } | undefined {
  let unreadable: string | undefined;
  const scripts = findSourceFiles(sourceDir, 'tools', /^encrypt-env\.(c?js|ts)$/);
  for (const script of scripts) {
    const text = readSource(sourceDir, script) ?? '';
    const listed = !text.includes('ENC(') ? listedKeys(text) : undefined;
    if (!text.includes('ENC(') && !listed) continue;
    const publicKeys = listed ? [] : stringArrayConst(text, 'PUBLIC_ENV_KEYS');
    if (!publicKeys) {
      unreadable = script;
      continue;
    }
    const envFiles = findSourceFiles(sourceDir, 'environments', /^environment.*\.ts$/, 2);
    // Profiles next to the env files (environments/<app>/app.profile.ts) only.
    const profiles = findSourceFiles(sourceDir, 'environments', /^app\.profile\.ts$/, 2).filter(
      (f) => /^environments\/[^/]+\/app\.profile\.ts$/.test(f),
    );
    const declared = new Set<string>();
    for (const f of envFiles) {
      for (const field of environmentFields(readSource(sourceDir, f) ?? ''))
        declared.add(field.key);
    }
    return {
      script,
      ...(listed ? { mode: 'listed' as const, keys: listed } : {}),
      publicKeys,
      profileFiles: listed ? [] : profiles.length > 0 ? ['app.profile.ts'] : [],
      timeField: declared.has('timeStamp') ? 'timeStamp' : undefined,
      branchField: declared.has('branchName')
        ? 'branchName'
        : declared.has('branch')
        ? 'branch'
        : undefined,
    };
  }
  return unreadable ? { unreadable } : undefined;
}

/** True when the workspace block is absent or still the untouched default of the preset/migration. */
function isDefaultBlock(raw: unknown): boolean {
  if (raw === undefined) return true;
  let cfg: EnvEncryptionConfig;
  try {
    cfg = normalizeEnvEncryption(raw);
  } catch {
    return false;
  }
  const stampDefault =
    cfg.stamp === undefined || JSON.stringify(cfg.stamp) === JSON.stringify(DEFAULT_STAMP);
  return (
    cfg.mode === 'listed' &&
    Object.values(cfg.keys).every((k) => k.length === 0) &&
    JSON.stringify(cfg.publicKeys) === JSON.stringify(DEFAULT_PUBLIC_KEYS) &&
    cfg.profileFiles.length === 0 &&
    cfg.cipher === 'cryptojs' &&
    JSON.stringify(cfg.keySources) === JSON.stringify(['commit']) &&
    cfg.metaName === 'x-build' &&
    stampDefault
  );
}

/** Projects (outside `copiedRoots`) that build through the polystack release executor. */
function otherReleaseProjects(tree: Tree, copiedRoots: string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    for (const child of tree.children(dir)) {
      const p = dir ? `${dir}/${child}` : child;
      if (child === 'project.json' && tree.isFile(p)) {
        const root = dir;
        if (copiedRoots.some((r) => root === r || root.startsWith(`${r}/`))) continue;
        try {
          const pj = JSON.parse(tree.read(p, 'utf8') ?? '{}');
          const targets = Object.values(pj.targets ?? {}) as { executor?: string }[];
          if (targets.some((t) => t.executor === POLYSTACK_BUILD_EXECUTOR))
            out.push(pj.name ?? root);
        } catch {
          // Unreadable project.json: not ours to judge.
        }
      } else if (
        depth > 0 &&
        !tree.isFile(p) &&
        !['node_modules', 'dist', 'tmp', 'coverage', 'out-tsc'].includes(child) &&
        !child.startsWith('.')
      ) {
        visit(p, depth - 1);
      }
    }
  };
  visit('', 6);
  return out.sort();
}

/** C2: settings that make the release build encrypt like the source's script. */
export function applySourceEnvEncryption(
  tree: Tree,
  sourceDir: string,
  notes: string[],
  copiedRoots: string[] = [],
): SourceEnvEncryption | undefined {
  const detected = detectSourceEnvEncryption(sourceDir);
  if (detected && 'unreadable' in detected) {
    notes.push(
      `Env encryption: the source encrypts its env files with ${code(
        detected.unreadable,
      )}, but its ` +
        'public keys list could not be read (it is not a plain list of strings); set the release ' +
        "build's settings by hand with `pstack encryption`.",
    );
    return undefined;
  }
  const found = detected as SourceEnvEncryption | undefined;
  if (!found || !tree.exists('nx.json')) return found;
  const raw = readEnvEncryptionBlock(tree);
  const listed = found.mode === 'listed';
  const settings = [
    listed ? 'mode `listed`' : 'mode `all`',
    listed ? 'format `raw`' : 'format `enc`',
    listed
      ? `keys ${(found.keys ?? []).map(code).join(', ')}`
      : `publicKeys ${found.publicKeys.map(code).join(', ')}`,
    found.profileFiles.length > 0 ? `profileFiles ${code('app.profile.ts')}` : '',
    found.timeField || found.branchField
      ? `stamp fields ${[found.timeField, found.branchField]
          .filter(Boolean)
          .map((f) => code(f as string))
          .join(' / ')}`
      : '',
  ].filter(Boolean);
  const others = otherReleaseProjects(tree, copiedRoots);
  if (others.length > 0) {
    notes.push(
      `Env encryption: the source encrypts its env files with ${code(
        found.script,
      )} (${settings.join(', ')}). The workspace's settings apply to every app, and ${others
        .map(code)
        .join(', ')} already ` +
        'build with them, so they were kept: the imported apps are encrypted as the workspace ' +
        'says until you change it with `pstack encryption`.',
    );
    return found;
  }
  if (!isDefaultBlock(raw)) {
    notes.push(
      `Env encryption: the source encrypts its env files with ${code(
        found.script,
      )} (${settings.join(', ')}); the workspace already has its own ${code(
        'pstack.envEncryption',
      )} settings, so they ` + 'were kept. Compare them with `pstack encryption`.',
    );
    return found;
  }
  const base = normalizeEnvEncryption(raw);
  writeEnvEncryptionBlock(tree, {
    ...base,
    ...(listed
      ? { mode: 'listed' as const, format: 'raw' as const, keys: { default: found.keys ?? [] } }
      : {
          mode: 'all' as const,
          format: 'enc' as const,
          publicKeys: found.publicKeys,
          profileFiles: found.profileFiles,
        }),
    stamp:
      found.timeField || found.branchField
        ? {
            ...DEFAULT_STAMP,
            ...(base.stamp ?? {}),
            timeField: found.timeField ?? DEFAULT_STAMP.timeField,
            branchField: found.branchField ?? DEFAULT_STAMP.branchField,
          }
        : base.stamp,
  });
  notes.push(
    `Env encryption: the source encrypts its env files with ${code(found.script)}; ` +
      `${code('nx.json')} ${code('pstack.envEncryption')} now does the same in release builds ` +
      `(${settings.join(', ')}). Set the build stamp time zone and format with ` +
      '`pstack encryption --timezone=… --stamp-format=…` if the source used others.',
  );
  return { ...found, applied: true };
}

const WRAPPER_EXPORTS = new Set([
  'envSecret',
  'decryptEnvValue',
  'getBuildMeta',
  'decryptEnvironment',
  'EncryptedEnvKey',
]);

/** Names a module exports (declarations and `export { … }` lists); `default` for a default export. */
export function exportedNames(text: string): string[] {
  const code = stripComments(text);
  const names = new Set<string>();
  for (const m of code.matchAll(
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  if (/\bexport\s+default\b/.test(code) || /\bexport\s*\*/.test(code)) names.add('default');
  // Destructured exports (export const { a, b } = x) are not listed: an unknown shape.
  if (/\bexport\s+(?:const|let|var)\s*[{[]/.test(code)) names.add('(destructured)');
  return [...names];
}

/**
 * Whether an env-secret.ts has the known shape: CryptoJS with the ENC() marker, exports
 * envSecret and decryptEnvironment, exports nothing the wrapper would not keep, and imports
 * `environment` from a relative path or the `@env/` alias.
 */
export function isKnownEnvSecret(text: string): { envImport: string } | undefined {
  const names = exportedNames(text);
  if (!names.includes('envSecret') || !names.includes('decryptEnvironment')) return undefined;
  if (names.some((n) => !WRAPPER_EXPORTS.has(n))) return undefined;
  // A narrower key type (e.g. keyof typeof environment) would be widened by the wrapper.
  const keyType = /\btype\s+EncryptedEnvKey\s*=\s*([^;\n]+)/.exec(stripComments(text));
  if (keyType && keyType[1].trim() !== 'string') return undefined;
  if (!/crypto-js/.test(text) || !text.includes('ENC(')) return undefined;
  const m = /import\s*\{\s*environment\s*\}\s*from\s*(['"])((?:\.|@env\/)[^'"]+)\1/.exec(text);
  return m ? { envImport: m[2] } : undefined;
}

export function envSecretWrapper(file: string, envImport: string): string {
  return `// ${file}
// Env secrets through the nx-polystack runtime module (rewritten by pstack migrate). The release
// build encrypts env values (nx.json pstack.envEncryption) and the runtime decrypts ENC(...)
// values with the build commit from <meta name="x-build">, as the original module did. With
// cipher aes-gcm, main.ts awaits envReady and decryptEnvironmentAsync decrypts other objects.
import {
  decryptEnvValue as runtimeDecryptEnvValue,
  decryptTree,
  decryptTreeAsync,
  envReady,
  envReadySync,
  envSecret as runtimeEnvSecret,
  getBuildMeta as runtimeGetBuildMeta,
  type BuildMeta,
} from '${RUNTIME_MODULE}';

import { environment } from '${envImport}';

/** Any environment field can be encrypted at build, so this is any key of the env object. */
export type EncryptedEnvKey = string;

let ready = false;
function ensureReady(): void {
  if (!ready) {
    envReadySync(environment);
    ready = true;
  }
}

/** Build metadata from <meta name="x-build">, or null (dev server / tests). */
export function getBuildMeta(): BuildMeta | null {
  return runtimeGetBuildMeta();
}

/** Decrypts one build-encrypted value; returns it unchanged if it is not ciphertext. */
export function decryptEnvValue(value: string, commit?: string | null): string {
  return runtimeDecryptEnvValue(value, commit);
}

/** Plaintext value of an environment field ('' when the env file does not define it). */
export function envSecret(key: EncryptedEnvKey): string {
  ensureReady();
  return runtimeEnvSecret(key);
}

/** Decrypts every ENC(...) value of the environment in place; returns the dotted paths decrypted. */
export function decryptEnvironment(
  env: Record<string, unknown> = environment as Record<string, unknown>,
): string[] {
  if (env !== (environment as unknown)) return decryptTree(env);
  ready = true;
  return envReadySync(environment, { inPlace: true });
}

/**
 * Decrypts every encrypted value in place (aes-gcm ENC2 too) with the key registered by envReady:
 * the environment without an argument, else that object; returns the dotted paths decrypted.
 */
export function decryptEnvironmentAsync(obj?: object): Promise<string[]> {
  return obj ? decryptTreeAsync(obj) : envReady(environment, { inPlace: true });
}
`;
}

/** C1: known-shape env-secret.ts files under `roots` become wrappers of the runtime module. */
export function swapEnvSecretModules(
  tree: Tree,
  roots: string[],
  notes: string[],
  sourceDir?: string,
): void {
  const swapped: string[] = [];
  const kept: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (!tree.exists(dir) || tree.isFile(dir)) return;
    for (const child of tree.children(dir)) {
      const p = `${dir}/${child}`;
      if (tree.isFile(p)) {
        if (child !== 'env-secret.ts') continue;
        const text = tree.read(p, 'utf8') ?? '';
        if (text.includes(RUNTIME_MODULE)) continue;
        // Only files this import copied (a workspace file kept in a shared folder is left alone).
        if (sourceDir !== undefined && readSource(sourceDir, p) !== text) continue;
        const shape = isKnownEnvSecret(text);
        if (shape) {
          tree.write(p, envSecretWrapper(p, shape.envImport));
          swapped.push(p);
        } else if (/crypto-js|ENC\(/.test(text)) {
          kept.push(p);
        }
      } else if (depth > 0 && child !== 'node_modules' && !child.startsWith('.')) {
        visit(p, depth - 1);
      }
    }
  };
  for (const root of [...new Set(roots)].sort()) visit(root, 6);
  if (swapped.length > 0) {
    notes.push(
      `Env secrets: ${swapped.map(code).join(', ')} now wrap ${code(RUNTIME_MODULE)} ` +
        '(same exports: envSecret, decryptEnvValue, getBuildMeta, decryptEnvironment, plus ' +
        'decryptEnvironmentAsync for cipher aes-gcm); modules ' +
        'that import them, such as env-init.ts, are unchanged. envSecret() caches each value ' +
        'after its first read; code that changes `environment` at runtime and reads it again ' +
        'through envSecret() sees the first value.',
    );
  }
  if (kept.length > 0) {
    notes.push(
      `Env secrets: ${kept.map(code).join(', ')} decrypt env values their own way and were kept; ` +
        `check them against ${code(RUNTIME_MODULE)} and the release build's settings.`,
    );
  }
}
