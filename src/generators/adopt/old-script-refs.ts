import * as path from 'path';

import { Tree } from '@nx/devkit';

import { keepJsonLayout, loadJsonc } from '../../lib/utils/json-layout';

/**
 * What still names the old build scripts after `pstack adopt --remove-old-scripts` deleted them:
 * ignore files, config lists, code comments and docs. Executing references (package.json,
 * project.json, CI, hooks, imports) never get here: a script something still starts is not
 * removed (old-scripts.ts).
 */

const posix = path.posix;

export interface ScriptRefEdits {
  /** `file:line` and what was done, for the log and the report. */
  edited: string[];
  /** `file:line` mentions left as they were (in code, or a JSON value that is not a list item). */
  review: string[];
}

/** The release target that replaced the old scripts, as docs should name it. */
const RELEASE = '`nx run <app>:release:<env>`';

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'tmp',
  'coverage',
  '.git',
  '.nx',
  '.angular',
  'release-packages',
]);

const LINE_LISTS =
  /^(\.gitignore|\.prettierignore|\.eslintignore|\.npmignore|\.dockerignore|\.secretlintignore|\.stylelintignore|CODEOWNERS)$/;
const JSON_FILE = /\.json$|^\.(eslintrc|lintstagedrc|prettierrc)$/;
const DOC = /\.(md|mdx|markdown|txt|adoc)$/i;
/** Files with // and /* *\/ comments. */
const SLASH_COMMENTS =
  /\.(?:[cm]?[jt]sx?|scss|less|css|java|kt|swift|dart|gradle|groovy)$|^Jenkinsfile/;
/** Files with # comments. */
const HASH_COMMENTS =
  /\.(?:sh|bash|zsh|ya?ml|toml|properties|rb|py|ps1)$|^Dockerfile|^Makefile$|^\.env/;

function textFiles(tree: Tree, skip: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 10) return;
    for (const name of tree.children(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const rel = dir === '.' || dir === '' ? name : `${dir}/${name}`;
      if (tree.isFile(rel)) {
        if (!skip.has(rel)) out.push(rel);
      } else {
        walk(rel, depth + 1);
      }
    }
  };
  walk('.', 0);
  return out.sort();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** A pattern for one script: its workspace path, with or without ./ or ../ in front. */
function scriptPattern(script: string): RegExp {
  return new RegExp(`(?:\\.{1,2}/)*${esc(script)}(?![\\w/-]|\\.\\w)`);
}

/** Lines of a text, with their line ending kept. */
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Removes JSON array items (strings) that name a script; other mentions are reported. */
function editJson(
  root: string,
  file: string,
  text: string,
  names: RegExp,
  res: ScriptRefEdits,
): string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // jsonc with comments: handled as a slash-comment file below.
    return editComments(file, text, names, res, true);
  }
  const removed: string[] = [];
  let other = false;
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v
        .filter((x) => {
          if (typeof x === 'string' && names.test(x)) {
            removed.push(x);
            return false;
          }
          return true;
        })
        .map(visit);
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (typeof x === 'string' && names.test(x)) other = true;
        else (v as Record<string, unknown>)[k] = visit(x);
      }
    }
    return v;
  };
  const after = visit(json);
  if (other) {
    lines(text).forEach((l, i) => {
      if (names.test(l) && !removed.some((r) => l.includes(JSON.stringify(r)))) {
        res.review.push(`${file}:${i + 1}`);
      }
    });
  }
  if (removed.length === 0) return text;
  const out = JSON.stringify(after, null, 2);
  const jsonc = loadJsonc(root);
  res.edited.push(`${file}: removed ${removed.map((r) => `"${r}"`).join(', ')}`);
  return (jsonc && keepJsonLayout(jsonc, text, out)) || `${out}\n`;
}

/**
 * Comment lines that name a script are deleted; a trailing comment that does is cut from its
 * line. Mentions outside comments are reported, not edited.
 */
function editComments(
  file: string,
  text: string,
  names: RegExp,
  res: ScriptRefEdits,
  slash: boolean,
): string {
  const out: string[] = [];
  let inBlock = false;
  lines(text).forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    const body = line.replace(/\r?\n$/, '');
    const startsBlock = slash && /^\s*\/\*/.test(body) && !/\*\//.test(body);
    const blockLine = inBlock || startsBlock;
    if (slash) {
      if (startsBlock) inBlock = true;
      if (inBlock && /\*\//.test(body)) inBlock = false;
    }
    if (!names.test(body)) {
      out.push(line);
      return;
    }
    // A line that is only comment: `// …`, a ` * …` line of a block, a plain line inside a
    // block, a one-line `/* … */`, or `# …`. Lines that open or close a block stay.
    const whole = slash
      ? /^\s*\/\//.test(body) ||
        /^\s*\/\*.*\*\/\s*$/.test(body) ||
        (blockLine && !startsBlock && !/\*\//.test(body))
      : /^\s*#/.test(body);
    if (whole) {
      res.edited.push(`${where}: comment line removed`);
      return;
    }
    const marker = slash ? body.search(/\s\/\/\s/) : body.search(/\s#\s/);
    if (marker >= 0 && names.test(body.slice(marker)) && !names.test(body.slice(0, marker))) {
      out.push(body.slice(0, marker).replace(/\s+$/, '') + line.slice(body.length));
      res.edited.push(`${where}: trailing comment removed`);
      return;
    }
    res.review.push(where);
    out.push(line);
  });
  return out.join('');
}

/** Docs: a code span or command naming a script becomes the release target; prose likewise. */
function editDoc(file: string, text: string, scripts: string[], res: ScriptRefEdits): string {
  let fenced = false;
  const out = lines(text).map((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    let next = line;
    for (const s of scripts) {
      const p = scriptPattern(s);
      if (!p.test(next)) continue;
      if (fenced) {
        // A command line in a code block: the release target command.
        next = next.replace(
          /^(\s*(?:\$\s*)?)(?:npx\s+)?node\s+\S+.*?(\r?\n)?$/,
          (_m, lead: string, nl?: string) => `${lead}npx nx run <app>:release:<env>${nl ?? ''}`,
        );
        if (p.test(next)) next = next.replace(new RegExp(p.source, 'g'), 'the release target');
      } else {
        next = next
          .replace(new RegExp('`[^`\\n]*' + p.source + '[^`\\n]*`', 'g'), RELEASE)
          .replace(new RegExp(p.source, 'g'), `the release target (${RELEASE})`);
      }
    }
    if (next !== line) res.edited.push(`${file}:${i + 1}: now names the release target`);
    return next;
  });
  return out.join('');
}

/**
 * Removes or rewrites what still names the removed scripts. `keep` lists files left as they are
 * (the adopt report, which records what was removed). Changelogs are history and are kept too.
 */
export function removeScriptReferences(
  tree: Tree,
  scripts: string[],
  keep: string[] = [],
): ScriptRefEdits {
  const res: ScriptRefEdits = { edited: [], review: [] };
  if (scripts.length === 0) return res;
  const names = new RegExp(scripts.map((s) => scriptPattern(s).source).join('|'));
  for (const file of textFiles(tree, new Set(keep))) {
    const base = posix.basename(file);
    if (/^CHANGELOG/i.test(base) || base === 'package-lock.json') continue;
    const buf = tree.read(file);
    if (!buf || buf.includes(0)) continue;
    const text = buf.toString('utf8');
    if (!names.test(text)) continue;
    let out = text;
    if (LINE_LISTS.test(base)) {
      out = lines(text)
        .filter((l, i) => {
          if (!names.test(l)) return true;
          res.edited.push(`${file}:${i + 1}: entry removed`);
          return false;
        })
        .join('');
    } else if (JSON_FILE.test(base)) {
      out = editJson(tree.root, file, text, names, res);
    } else if (DOC.test(base)) {
      out = editDoc(file, text, scripts, res);
    } else if (SLASH_COMMENTS.test(base) || /\.html$/.test(base)) {
      out = /\.html$/.test(base)
        ? text // HTML: comments are <!-- -->; report only.
        : editComments(file, text, names, res, true);
      if (/\.html$/.test(base)) {
        lines(text).forEach((l, i) => names.test(l) && res.review.push(`${file}:${i + 1}`));
      }
    } else if (HASH_COMMENTS.test(base)) {
      out = editComments(file, text, names, res, false);
    } else {
      lines(text).forEach((l, i) => names.test(l) && res.review.push(`${file}:${i + 1}`));
    }
    if (out !== text) tree.write(file, out);
  }
  return res;
}
