import * as path from 'path';

import { Tree } from '@nx/devkit';

/** The library's runtime CSP nonce patch (see runtime/csp-nonce.js). */
export const CSP_NONCE_IMPORT = '@mouryaamit/nx-polystack/runtime/csp-nonce';

const IMPORT_LINE = `import '${CSP_NONCE_IMPORT}';`;
const COMMENT =
  "// Gives <script>/<style> elements added at runtime the page's CSP nonce (keep it first).";

/** Side-effect imports: `import './x';` (one per line). */
const SIDE_EFFECT = /^[ \t]*import[ \t]+(['"])([^'"]+)\1[ \t]*;?[ \t]*(\/\/.*)?$/gm;

export const hasCspNonceImport = (text: string): boolean => text.includes(CSP_NONCE_IMPORT);

/**
 * `text` with the library import as its first statement (unchanged when already there). It goes
 * after a shebang and `/// <reference …>` directives, which only count before any statement.
 */
export function withCspNonceImport(text: string): string {
  if (hasCspNonceImport(text)) return text;
  const lines = text.split('\n');
  // After the last shebang or `///` directive of the leading block of comments and blank lines.
  let at = 0;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (/^#!/.test(line) || /^\/\/\/\s*</.test(line)) at = i + 1;
    else if (line.startsWith('/*')) inBlock = !line.includes('*/');
    else if (!(line === '' || line.startsWith('//'))) break;
  }
  const head = lines.slice(0, at);
  const rest = lines.slice(at).join('\n');
  const block = `${COMMENT}\n${IMPORT_LINE}\n${rest.startsWith('\n') || rest === '' ? '' : '\n'}`;
  return head.length > 0 ? `${head.join('\n')}\n${block}${rest}` : `${block}${rest}`;
}

const RESOLVE_SUFFIXES = ['', '.ts', '.js', '.mjs', '/index.ts', '/index.js'];

/**
 * What a local side-effect import is:
 * - `compatible`: a nonce patch that reads the nonce where the library does
 *   (`window.__cspNonce` or the csp-nonce meta tag), so the library can replace it;
 * - `other`: a nonce patch that reads it some other way (or can't be read), kept as is;
 * - `none`: not a nonce patch.
 */
function noncePatchKind(spec: string, text: string | undefined): 'compatible' | 'other' | 'none' {
  if (text === undefined) {
    return /csp[-_]?nonce|nonce[-_]?patch/i.test(path.posix.basename(spec)) ? 'other' : 'none';
  }
  if (!/nonce/i.test(text) || !/(appendChild|insertBefore)/.test(text)) return 'none';
  return /__cspNonce|csp-nonce/i.test(text) ? 'compatible' : 'other';
}

export interface NoncePatchSwap {
  /** The new main.ts text. */
  text: string;
  /** Local nonce patch imports replaced by the library's (specifiers as written). */
  replaced: string[];
  /** Local nonce patch imports kept (the library import was added before them). */
  kept: string[];
}

export interface NoncePatchOptions {
  /** Replace compatible local patches (`:migrate`); false keeps every local import. */
  replaceLocal: boolean;
}

/**
 * main.ts (`file`, workspace-relative) with the library nonce patch: a compatible local patch
 * import is replaced in place; otherwise the library import is added first and local ones stay.
 * `read` returns a workspace file (or undefined).
 */
export function useLibraryNoncePatch(
  file: string,
  text: string,
  read: (workspacePath: string) => string | undefined,
  opts: NoncePatchOptions = { replaceLocal: true },
): NoncePatchSwap {
  const replaced: string[] = [];
  const kept: string[] = [];
  let swapped = text.replace(SIDE_EFFECT, (line, _q, spec: string) => {
    if (!spec.startsWith('.')) return line;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    const target = RESOLVE_SUFFIXES.map((s) => base + s).find((p) => read(p) !== undefined);
    const kind = noncePatchKind(spec, target ? read(target) : undefined);
    if (kind === 'none') return line;
    if (kind === 'other' || !opts.replaceLocal || hasCspNonceImport(text)) {
      kept.push(spec);
      return line;
    }
    replaced.push(spec);
    return replaced.length === 1 ? `${IMPORT_LINE} // was '${spec}'` : `// was: ${line.trim()}`;
  });
  // A replaced import stays where the local patch was imported (normally first).
  if (replaced.length === 0) swapped = withCspNonceImport(swapped);
  return { text: swapped, replaced, kept };
}

/** Applies useLibraryNoncePatch to a main.ts in the tree. */
export function patchMainInTree(
  tree: Tree,
  mainFile: string,
  opts?: NoncePatchOptions,
): NoncePatchSwap | undefined {
  if (!tree.exists(mainFile)) return undefined;
  const text = tree.read(mainFile, 'utf8') ?? '';
  const result = useLibraryNoncePatch(
    mainFile,
    text,
    (p) => (tree.exists(p) && tree.isFile(p) ? tree.read(p, 'utf8') ?? '' : undefined),
    opts,
  );
  if (result.text !== text) tree.write(mainFile, result.text);
  return result;
}

const code = (s: string) => `\`${s}\``;

/**
 * Patches the main.ts of migrated apps and returns the report note (undefined when nothing
 * changed). `mains` are workspace paths.
 */
export function noncePatchMains(tree: Tree, mains: string[]): string | undefined {
  const added: string[] = [];
  const swapped: string[] = [];
  const keptLocal: string[] = [];
  for (const main of mains) {
    const before = tree.exists(main) ? tree.read(main, 'utf8') : undefined;
    const result = patchMainInTree(tree, main, { replaceLocal: true });
    if (result === undefined) continue;
    if (result.kept.length > 0) {
      keptLocal.push(`${code(main)} (${result.kept.map(code).join(', ')})`);
    }
    if (tree.read(main, 'utf8') === before) continue;
    if (result.replaced.length > 0) {
      swapped.push(`${code(main)} (was ${result.replaced.map(code).join(', ')})`);
    } else added.push(code(main));
  }
  const parts: string[] = [];
  if (swapped.length > 0) {
    parts.push(
      `the local CSP nonce patch import was replaced by ${code(CSP_NONCE_IMPORT)} in ` +
        `${swapped.join(', ')}; the local file stays where it was copied, delete it once ` +
        'nothing imports it',
    );
  }
  if (added.length > 0) {
    parts.push(
      `${code(CSP_NONCE_IMPORT)} was added first in ${added.join(', ')} (it gives runtime ` +
        '<script>/<style> elements the page CSP nonce; without a nonce it does nothing)',
    );
  }
  if (keptLocal.length > 0) {
    parts.push(
      `local nonce patches that read the nonce some other way were kept in ${keptLocal.join(
        ', ',
      )}; check whether the library patch can replace them`,
    );
  }
  return parts.length > 0 ? `CSP nonce: ${parts.join('; ')}.` : undefined;
}
