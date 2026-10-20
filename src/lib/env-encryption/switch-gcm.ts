import * as path from 'path';

import { Tree } from '@nx/devkit';

import { POLYSTACK_BUILD_EXECUTOR } from '../utils/angular-project';
import { FoundProject, findProjects } from '../utils/llm-block';
import { envAliasImport, hasEnvAlias } from '../utils/env-alias';
import { EnvEncryptionConfig, listedKeys } from './config';
import { closingBracket, isCodeAt, quotedStrings, stripComments } from './env-file';

const RUNTIME = '@mouryaamit/nx-polystack/runtime/env-secret';
const DEFAULT_META = 'x-build';

/** `envReady(<env>, { inPlace: true[, metaName][, extra] })`. */
function envReadyCall(env: string, metaName?: string, extra = ''): string {
  const meta = metaName && metaName !== DEFAULT_META ? `, metaName: '${metaName}'` : '';
  return `envReady(${env}, { inPlace: true${meta}${extra} })`;
}

/** Note for keySources custom under aes-gcm (no values). */
export function customKeyNote(metaName?: string): string {
  return (
    'keySources lists custom: main.ts must pass getKey to envReady, e.g. ' +
    `\`${envReadyCall('environment', metaName, ', getKey: () => fetchKey()')}\` (the build ` +
    'reads PSTACK_CUSTOM_KEY).'
  );
}

/** `code` with every single- or double-quoted string blanked (offsets kept). */
function blankStrings(code: string): string {
  let out = code;
  for (const s of quotedStrings(out).reverse()) {
    out = out.slice(0, s.start) + ' '.repeat(s.end - s.start) + out.slice(s.end);
  }
  return out;
}

/** Local name of the imported `environment` (`environment as env` → env), or undefined. */
function environmentLocalName(text: string): string | undefined {
  const code = stripComments(text);
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const entry of m[1].split(',')) {
      const parts = entry
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .map((p) => p.trim());
      if (parts[0] === 'environment') return parts[1] || parts[0];
    }
  }
  return undefined;
}

/**
 * main.ts awaiting envReady before bootstrap; undefined for an unknown shape (no
 * `platformBrowserDynamic().bootstrapModule(…)`, unbalanced brackets, or another chained call);
 * the same text when it already calls envReady. The bootstrap arguments and the catch handler are
 * kept as written.
 */
export function rewriteMainForGcm(
  text: string,
  envImport: string,
  metaName?: string,
): string | undefined {
  if (/\benvReady\s*\(/.test(blankStrings(stripComments(text)))) return text;
  const re = /\bplatformBrowserDynamic\s*\(\s*\)\s*\.\s*bootstrapModule\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && !isCodeAt(text, m.index));
  if (!m) return undefined;
  const open = m.index + m[0].length - 1;
  const close = closingBracket(text, open);
  if (close < 0) return undefined;
  const args = text.slice(open + 1, close);
  let end = close + 1;
  let handler: string | undefined;
  const c = /^\s*\.\s*catch\s*\(/.exec(text.slice(end));
  if (c) {
    const cOpen = end + c[0].length - 1;
    const cClose = closingBracket(text, cOpen);
    if (cClose < 0) return undefined;
    handler = text.slice(cOpen + 1, cClose);
    end = cClose + 1;
  }
  if (/^\s*\./.test(text.slice(end))) return undefined;
  const semi = /^\s*;/.exec(text.slice(end));
  if (semi) end += semi[0].length;
  const local = environmentLocalName(text);
  const call =
    `${envReadyCall(local ?? 'environment', metaName)}\n` +
    `  .then(() => platformBrowserDynamic().bootstrapModule(${args}))` +
    `${handler !== undefined ? `\n  .catch(${handler})` : ''};`;
  let out = text.slice(0, m.index) + call + text.slice(end);
  const imports: string[] = [`import { envReady } from '${RUNTIME}';`];
  if (local === undefined) imports.push(`import { environment } from '${envImport}';`);
  const lastImport = [...out.matchAll(/^import\b[^;]*;/gm)].pop();
  if (lastImport) {
    const at = (lastImport.index ?? 0) + lastImport[0].length;
    out = `${out.slice(0, at)}\n${imports.join('\n')}${out.slice(at)}`;
  } else {
    out = `${imports.join('\n')}\n\n${out}`;
  }
  return out;
}

interface Frame {
  /** A function, method or statement block: its code does not run at import. */
  block: boolean;
  /** A class body: only static members run at import. */
  cls?: { isStatic: boolean };
}

/**
 * Non-public `environment.<key>` reads that run at import, before envReady: outside functions,
 * method bodies, instance fields and arrow expression bodies; static fields, template literals
 * and `const { a } = environment` count. Heuristic: a `{` preceded by `)`, `=>` or a word other
 * than `return` / `default` opens a block (after `class …` a class body); one preceded by `=`,
 * `:`, `(`, `,`, `[`, `?` or `return` is an object literal.
 */
export function moduleScopeEnvReads(text: string, publicKeys: string[]): string[] {
  const code = blankStrings(stripComments(text));
  const stack: Frame[] = [];
  let deferDepth = -1;
  const out: string[] = [];
  const add = (k: string) => {
    if (!publicKeys.includes(k) && !out.includes(k)) out.push(k);
  };
  const top = () => stack[stack.length - 1];
  const runsAtImport = (): boolean => {
    if (deferDepth >= 0 || stack.some((f) => f.block)) return false;
    const cls = [...stack].reverse().find((f) => f.cls);
    return !cls || (cls.cls as { isStatic: boolean }).isStatic;
  };
  const re =
    /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*environment\b(?!\s*[.\w$])|(?<![\w$.])environment\.([A-Za-z_$][\w$]*)|\bstatic\b|=>|\$\{|[{}()[\],;]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const t = m[0];
    if (m[1] !== undefined) {
      if (!runsAtImport()) continue;
      for (const part of m[1].split(',')) {
        const key = part.trim();
        if (key && !key.startsWith('...')) add(key.split(/[:=]/)[0].trim());
      }
    } else if (m[2] !== undefined) {
      if (runsAtImport()) add(m[2]);
    } else if (t === 'static') {
      if (top()?.cls) (top().cls as { isStatic: boolean }).isStatic = true;
    } else if (t === '=>') {
      if (!/^\s*\{/.test(code.slice(re.lastIndex)) && deferDepth < 0) deferDepth = stack.length;
    } else if (t === '${' || t === '(' || t === '[') {
      stack.push({ block: false });
    } else if (t === '{') {
      const before = code.slice(0, m.index).trimEnd();
      if (/\bclass\b[^{};=()]*$/.test(before)) {
        stack.push({ block: false, cls: { isStatic: false } });
      } else {
        const block = /(\)|=>|(?:^|[^\w$])(?!return$|default$)[A-Za-z_$][\w$]*)$/.test(before);
        stack.push({ block });
      }
    } else if (t === '}' || t === ')' || t === ']') {
      stack.pop();
      if (deferDepth > stack.length) deferDepth = -1;
      if (t === '}' && top()?.cls) (top().cls as { isStatic: boolean }).isStatic = false;
    } else {
      // , or ;
      if (deferDepth === stack.length) deferDepth = -1;
      if (t === ';' && top()?.cls) (top().cls as { isStatic: boolean }).isStatic = false;
    }
  }
  return out;
}

/**
 * Arguments of `decryptEnvironment(<arg>)` calls on objects outside environment (calls without an
 * argument, or on `environment` or a part of it, are left out; so is the function's declaration).
 */
export function decryptEnvironmentCalls(text: string): string[] {
  const code = stripComments(text);
  const out: string[] = [];
  const re = /\bdecryptEnvironment\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (/\bfunction\s*$/.test(code.slice(0, m.index))) continue;
    const open = m.index + m[0].length - 1;
    const close = closingBracket(code, open);
    if (close < 0) continue;
    const arg = code
      .slice(open + 1, close)
      .trim()
      .replace(/\s+/g, ' ');
    if (arg === '' || /^environment\b/.test(arg)) continue;
    if (!out.includes(arg)) out.push(arg);
  }
  return out;
}

const WRAPPER_ASYNC = `
/**
 * Decrypts every encrypted value in place (aes-gcm ENC2 too) with the key registered by envReady:
 * the environment without an argument, else that object; returns the dotted paths decrypted.
 */
export function decryptEnvironmentAsync(obj?: object): Promise<string[]> {
  return obj ? decryptTreeAsync(obj) : envReady(environment, { inPlace: true });
}
`;

/** Whether `text` is an env-secret wrapper written by pstack migrate (NX-39b). */
export function isMigratedWrapper(text: string): boolean {
  return text.includes('rewritten by pstack migrate');
}

/** The imported name of an import list entry (`a as b` → a, `type T` → T). */
const importedName = (entry: string): string =>
  entry
    .replace(/^type\s+/, '')
    .split(/\s+as\s+/)[0]
    .trim();

/**
 * A migrated env-secret wrapper with `decryptEnvironmentAsync` (and the runtime imports it needs);
 * the same text when it has it; undefined when it is not a wrapper of the known shape.
 */
export function rewriteWrapperForGcm(text: string): string | undefined {
  if (!isMigratedWrapper(text)) return undefined;
  if (/\bexport\s+(?:async\s+)?function\s+decryptEnvironmentAsync\b/.test(text)) return text;
  if (!/\bexport\s+function\s+decryptEnvironment\b/.test(text)) return undefined;
  if (!/import\s*\{\s*environment\s*\}\s*from/.test(text)) return undefined;
  const importRe = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${RUNTIME.replace(/[/.-]/g, '\\$&')}\\2;`,
  );
  const im = importRe.exec(text);
  if (!im) return undefined;
  const entries = im[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of ['decryptTreeAsync', 'envReady']) {
    if (entries.some((e) => importedName(e) === name)) continue;
    const at = entries.findIndex((e) => !e.startsWith('type ') && importedName(e) > name);
    const firstType = entries.findIndex((e) => e.startsWith('type '));
    entries.splice(at >= 0 ? at : firstType >= 0 ? firstType : entries.length, 0, name);
  }
  const imports = `import {\n${entries.map((e) => `  ${e},`).join('\n')}\n} from '${RUNTIME}';`;
  const out = text.slice(0, im.index) + imports + text.slice(im.index + im[0].length);
  return `${out.replace(/\s*$/, '\n')}${WRAPPER_ASYNC}`;
}

function tsFiles(tree: Tree, dir: string, out: string[] = []): string[] {
  if (!tree.exists(dir) || tree.isFile(dir)) return out;
  for (const c of tree.children(dir)) {
    const p = `${dir}/${c}`;
    if (tree.isFile(p)) {
      if (p.endsWith('.ts') && !p.endsWith('.spec.ts') && !p.endsWith('.d.ts')) out.push(p);
    } else if (!['node_modules', 'dist'].includes(c) && !c.startsWith('.')) {
      tsFiles(tree, p, out);
    }
  }
  return out;
}

type Targets = Record<string, { executor?: string; options?: Record<string, unknown> }>;

const projectName = (p: FoundProject): string =>
  typeof p.json['name'] === 'string' ? (p.json['name'] as string) : path.posix.basename(p.root);

const sourceRootOf = (p: FoundProject): string =>
  typeof p.json['sourceRoot'] === 'string' ? (p.json['sourceRoot'] as string) : p.root;

export interface SwitchOptions extends Partial<Pick<EnvEncryptionConfig, 'mode' | 'keys'>> {
  keySources?: string[];
  /** Meta tag of the build info; passed to envReady when it is not x-build. */
  metaName?: string;
}

/**
 * Rewrites main.ts of every release app and the migrated env-secret wrappers; returns report
 * lines (by file and key, no values). Apps and libraries are found by walking apps/ and libs/
 * (getProjects needs Nx's native file globbing). main.ts is scanned too (production excluded).
 * In listed mode only listed keys are reported.
 */
export function switchAppsToGcm(
  tree: Tree,
  publicKeys: string[],
  opts: SwitchOptions = {},
): string[] {
  const notes: string[] = [];
  const awaitCall = `await ${envReadyCall('environment', opts.metaName)}`;
  const listed = opts.mode === 'listed' && opts.keys !== undefined;
  const cfgKeys = { keys: opts.keys ?? {} } as EnvEncryptionConfig;
  const reported = (reads: string[], envProject?: string): string[] => {
    if (!listed) return reads;
    const keys =
      envProject === undefined
        ? Object.values(cfgKeys.keys).flat()
        : listedKeys(cfgKeys, envProject);
    return reads.filter((k) => keys.includes(k));
  };
  const scanned = new Set<string>();
  const scan = (files: string[], envProject?: string) => {
    for (const file of files) {
      if (scanned.has(file)) continue;
      scanned.add(file);
      const text = tree.read(file, 'utf8') ?? '';
      if (path.posix.basename(file) === 'env-secret.ts' && isMigratedWrapper(text)) {
        const next = rewriteWrapperForGcm(text);
        if (next === undefined) {
          notes.push(
            `${file}: add \`decryptEnvironmentAsync\` by hand (decryptTreeAsync / envReady from ` +
              `'${RUNTIME}'); decryptEnvironment() leaves aes-gcm values encrypted.`,
          );
        } else if (next !== text) {
          tree.write(file, next);
          notes.push(
            `${file} now exports decryptEnvironmentAsync (decryptEnvironment() leaves aes-gcm ` +
              'values encrypted).',
          );
        }
        continue;
      }
      const reads = reported(moduleScopeEnvReads(text, [...publicKeys, 'production']), envProject);
      if (reads.length > 0) {
        notes.push(`${file}: ${reads.join(', ')} read at import time (still encrypted then).`);
      }
      for (const arg of decryptEnvironmentCalls(text)) {
        notes.push(
          `${file}: decryptEnvironment(${arg}) stays encrypted under aes-gcm unless the object ` +
            `is part of environment; use \`await decryptEnvironmentAsync(${arg})\`.`,
        );
      }
    }
  };

  let releaseApps = 0;
  for (const p of findProjects(tree, 'apps')) {
    const targets = (p.json['targets'] ?? {}) as Targets;
    const release = Object.values(targets).find((t) => t.executor === POLYSTACK_BUILD_EXECUTOR);
    if (!release) continue;
    releaseApps++;
    const name = projectName(p);
    const buildTarget = String(release.options?.['buildTarget'] ?? `${name}:build`).split(':')[1];
    const main = targets[buildTarget]?.options?.['main'] as string | undefined;
    const envProject = String(release.options?.['envProject'] ?? name);
    const files = tsFiles(tree, sourceRootOf(p));
    if (main && tree.exists(main)) {
      const envFile = `environments/${envProject}/environment`;
      const rel = path.posix.relative(path.posix.dirname(main), envFile);
      const envImport = hasEnvAlias(tree)
        ? envAliasImport(envFile)
        : rel.startsWith('.')
        ? rel
        : `./${rel}`;
      const text = tree.read(main, 'utf8') ?? '';
      const next = rewriteMainForGcm(text, envImport, opts.metaName);
      if (next === undefined) {
        notes.push(
          `${name}: ${main} has an unknown shape; before bootstrapping add ` +
            `\`${awaitCall}\` (import envReady from '${RUNTIME}').`,
        );
      } else if (next !== text) {
        tree.write(main, next);
        notes.push(`${name}: ${main} now awaits envReady before bootstrap.`);
      }
      if (!files.includes(main)) files.unshift(main);
    } else {
      notes.push(`${name}: no main.ts found; ${awaitCall} before bootstrap.`);
    }
    scan(files, envProject);
  }
  if (releaseApps === 0) {
    notes.push(
      `No app under apps/ has a release target (${POLYSTACK_BUILD_EXECUTOR}); no main.ts was ` +
        `rewritten. Apps built another way must ${awaitCall} before bootstrap.`,
    );
  }
  for (const p of findProjects(tree, 'libs')) scan(tsFiles(tree, sourceRootOf(p)));
  if (opts.keySources?.includes('custom')) notes.push(customKeyNote(opts.metaName));
  return notes;
}
