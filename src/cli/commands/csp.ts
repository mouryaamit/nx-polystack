import * as fs from 'fs';
import * as path from 'path';

import { Tree } from '@nx/devkit';

import {
  buildPolicy,
  CSP_DIRECTIVES,
  CspAllowlist,
  CspDirective,
  parseAllowlist,
  serializeAllowlist,
} from '../../lib/csp/allowlist';
import { importPolicy, ImportResult, readPolicy } from '../../lib/csp/import';
import { GENERATED_MARKER, renderHtaccess, renderNginx } from '../../lib/csp/render';
import { POLYSTACK_BUILD_EXECUTOR } from '../../lib/utils/angular-project';
import { readProjects } from '../../lib/utils/project-json-files';
import { flagBoolean, flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

type Edit = { directive: CspDirective; source: string };

/** `directive:source[,directive:source…]`; the source may itself hold ":" (https://…). */
function parseEdits(flag: string, value: string | undefined): Edit[] {
  if (value === undefined) return [];
  const edits = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(':');
      const directive = entry.slice(0, at);
      const source = entry.slice(at + 1).trim();
      if (at < 1 || !source || !(directive in CSP_DIRECTIVES)) {
        throw new CliError(
          `--${flag}: "${entry}" must be <directive>:<source>, e.g. connect-src:https://api.example.com ` +
            `(directives: ${Object.keys(CSP_DIRECTIVES).join(', ')}).`,
        );
      }
      return { directive: directive as CspDirective, source };
    });
  if (edits.length === 0) throw new CliError(`--${flag} needs at least one <directive>:<source>.`);
  return edits;
}

/**
 * Whether the app's optimised Angular builds inline critical CSS (Angular's default): the
 * inlined stylesheet link gets an onload handler, which the strict script-src blocks.
 */
export function inlinesCriticalCss(projectJson: Record<string, unknown>): string[] {
  const targets = (projectJson['targets'] ?? {}) as Record<string, Record<string, unknown>>;
  const build = Object.values(targets).find((t) =>
    /^(@angular-devkit\/build-angular|@angular\/build|@nx\/angular):(browser|application|browser-esbuild|webpack-browser)$/.test(
      String(t['executor']),
    ),
  );
  if (!build) return [];
  const configs = (build['configurations'] ?? {}) as Record<string, Record<string, unknown>>;
  const options = (build['options'] ?? {}) as Record<string, unknown>;
  return Object.entries(configs)
    .filter(([, c]) => {
      const opt = c['optimization'] ?? options['optimization'] ?? true;
      if (opt === false) return false;
      if (opt === true) return true;
      const styles = (opt as Record<string, unknown>)['styles'] ?? true;
      if (styles === false) return false;
      if (styles === true) return true;
      return (styles as Record<string, unknown>)['inlineCritical'] !== false;
    })
    .map(([name]) => name);
}

type FileState = 'missing' | 'in sync' | 'differs' | 'hand-written';

function fileState(tree: Tree, file: string, wanted: string): FileState {
  const raw = tree.read(file, 'utf-8');
  if (raw === null) return 'missing';
  // A checkout with CRLF line endings is still in sync.
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith(GENERATED_MARKER)) return 'hand-written';
  return text === wanted ? 'in sync' : 'differs';
}

/**
 * --import value: a file (policy text, .htaccess / nginx.conf, JSON) relative to the caller's
 * folder, or a policy written inline.
 */
export function readImportSource(value: string, cwd: string): { label: string; text: string } {
  const file = path.resolve(cwd, value);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    return { label: value, text: fs.readFileSync(file, 'utf8') };
  }
  // A policy: a directive name followed by its sources, optionally after the header name.
  const policy =
    /^\s*(?:Content-Security-Policy:\s*)?[a-z-]+-(?:src|ancestors|action|uri|elem|attr)\s+\S/i;
  if (policy.test(value) || /^\s*[a-z-]+\s+[^;]*;\s*[a-z-]+\s/i.test(value)) {
    return { label: 'the policy given', text: value };
  }
  throw new CliError(
    `--import: no file "${value}". Give a file (a policy, .htaccess, nginx.conf or JSON) or the ` +
      'policy itself, e.g. --import="script-src \'self\' https://cdn.example.com".',
  );
}

/** Report lines for an import. */
export function importReport(
  label: string,
  format: string,
  r: ImportResult,
  readNotes: string[] = [],
): string[] {
  const lines = [`Imported from ${label} (${format}):`];
  const added = Object.entries(r.added);
  if (added.length === 0) lines.push('  nothing new');
  for (const [d, list] of added) lines.push(`  + ${d.padEnd(16)}${list.join(' ')}`);
  for (const c of r.covered) lines.push(`  = ${c.directive}: ${c.source} (covered by ${c.by})`);
  const group = (kind: 'refused' | 'not-taken', title: string) => {
    const items = r.skipped.filter((s) => s.kind === kind);
    if (items.length === 0) return;
    lines.push(title);
    for (const s of items) {
      lines.push(`  - ${s.directive}${s.source ? ` ${s.source}` : ''}: ${s.reason}`);
    }
  };
  group('refused', 'Refused (the strict policy does not allow them):');
  group('not-taken', 'Not taken (the generated policy has no place for them):');
  for (const n of [...readNotes, ...r.notes]) lines.push(`Note: ${n}`);
  return lines;
}

/** pstack csp --app=<project>: edit csp-allowlist.json and render .htaccess / nginx.conf from it. */
export async function runCsp(ctx: CommandContext): Promise<number> {
  for (const f of ['app', 'add', 'remove', 'import']) {
    if (ctx.flags[f] === true) throw new CliError(`--${f} needs a value.`);
  }
  const app = flagString(ctx.flags, 'app');
  if (!app) throw new CliError('--app=<project> is required.');
  const adds = parseEdits('add', flagString(ctx.flags, 'add'));
  const removes = parseEdits('remove', flagString(ctx.flags, 'remove'));
  const force = ctx.flags['force'] !== undefined && flagBoolean(ctx.flags, 'force');
  const importFlag = flagString(ctx.flags, 'import');
  const imported = importFlag === undefined ? undefined : readImportSource(importFlag, ctx.cwd);
  let parsedImport: ReturnType<typeof readPolicy> | undefined;
  if (imported) {
    try {
      parsedImport = readPolicy(imported.text);
    } catch (err) {
      throw new CliError(`--import: ${imported.label}: ${(err as Error).message}.`);
    }
  }
  const root = requireWorkspace(ctx.cwd, 'csp');

  const out: string[] = [];
  await runInTree(root, { ...ctx, quietWhenUnchanged: true }, (tree) => {
    let projects;
    try {
      projects = readProjects(tree);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    const project = projects.find((p) => p.name === app);
    if (!project) throw new CliError(`No project named "${app}".`);
    const targets = (project.json['targets'] ?? {}) as Record<string, { executor?: string }>;
    if (!Object.values(targets).some((t) => t.executor === POLYSTACK_BUILD_EXECUTOR)) {
      throw new CliError(
        `"${app}" has no release target (${POLYSTACK_BUILD_EXECUTOR}); pstack csp is for Angular and Ionic apps.`,
      );
    }

    const listFile = `${project.root}/csp-allowlist.json`;
    let allowlist: CspAllowlist;
    try {
      const text = tree.read(listFile, 'utf-8');
      allowlist = parseAllowlist(text === null ? {} : JSON.parse(text));
    } catch (err) {
      throw new CliError(`${listFile}: ${(err as Error).message}`);
    }
    const edited: CspAllowlist = {
      ...allowlist,
      sources: Object.fromEntries(
        Object.entries(allowlist.sources).map(([k, v]) => [k, [...(v as string[])]]),
      ),
    };
    let importLines: string[] = [];
    let importAdded = false;
    if (imported && parsedImport) {
      const result = importPolicy(parsedImport.policy, edited.sources);
      edited.sources = result.sources;
      importAdded = Object.keys(result.added).length > 0;
      importLines = importReport(imported.label, parsedImport.format, result, parsedImport.notes);
    }
    for (const { directive, source } of adds) {
      edited.sources[directive] = [...(edited.sources[directive] ?? []), source];
    }
    for (const { directive, source } of removes) {
      const before = edited.sources[directive] ?? [];
      if (!before.includes(source)) {
        out.push(`Note: ${directive} has no "${source}"; nothing removed.`);
      }
      edited.sources[directive] = before.filter((s) => s !== source);
    }
    let checked: CspAllowlist;
    try {
      checked = parseAllowlist(JSON.parse(serializeAllowlist(edited)));
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    // An import that adds nothing leaves csp-allowlist.json as it is (also its formatting).
    const edits = adds.length + removes.length + (importAdded ? 1 : 0);
    if (edits > 0) {
      const text = serializeAllowlist(checked);
      if (tree.read(listFile, 'utf-8') !== text) tree.write(listFile, text);
    }
    out.push(...importLines);

    out.unshift(
      `CSP of ${app} (${listFile}):`,
      ...Object.entries(checked.sources)
        .filter(([, v]) => (v as string[]).length > 0)
        .map(([k, v]) => `  ${k.padEnd(16)}${(v as string[]).join(' ')}`),
      `  policy          ${buildPolicy(checked).replace(/\{N\}/g, '<nonce>')}`,
    );

    for (const [file, text] of [
      [`${project.root}/src/.htaccess`, renderHtaccess(app, checked)],
      [`${project.root}/server/nginx.conf`, renderNginx(app, checked)],
    ] as const) {
      const state = fileState(tree, file, text);
      if (state === 'hand-written' && !force) {
        out.push(
          `  ${file}: hand-written, kept (--force replaces it)` +
            (edits > 0 ? ' — it does not have this change' : ''),
        );
      } else if (state === 'in sync') {
        out.push(`  ${file}: in sync`);
      } else {
        tree.write(file, text);
        const done = state === 'missing' ? 'written' : state === 'differs' ? 'updated' : 'replaced';
        out.push(`  ${file}: ${ctx.dryRun ? `would be ${done}` : done}`);
      }
    }

    const inlining = inlinesCriticalCss(project.json);
    if (inlining.length > 0) {
      out.push(
        `Warning: the ${inlining.join(', ')} build(s) inline critical CSS; its onload handler is ` +
          'blocked by this CSP. Set optimization.styles.inlineCritical to false there.',
      );
    }
  });
  for (const line of out) console.log(line);
  return 0;
}
