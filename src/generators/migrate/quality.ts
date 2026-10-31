import * as path from 'path';

import type { Tree } from '@nx/devkit';

import { replaceToolScripts } from '../../lib/old-scripts/tool-scripts';
import {
  addTypecheckNxDefaults,
  addTypecheckScript,
  analyzeTargetChange,
  hasTypecheckTargets,
  infersTypecheck,
  TYPECHECK_SCRIPT,
  typecheckTargetChange,
} from '../../lib/utils/quality';
import { liveScripts, scriptClosure } from '../adopt/old-scripts';

import type { MigrationReportData } from './adapters/types';
import type { Originals } from './rollback/recording-tree';

/**
 * Type checking for the projects a migration created: a `typecheck` target (tsc --noEmit, with
 * the ngc `templates` configuration on Angular projects) where a tsconfig.app/lib.json exists, an
 * `analyze` target on Flutter projects, typecheck cached in nx.json, and the root `typecheck`
 * npm script.
 */
export function applyTypecheck(tree: Tree, originals: Originals, data: MigrationReportData): void {
  const created = [...originals.entries()]
    .filter(([file, before]) => before === null && /(^|\/)project\.json$/.test(file))
    .map(([file]) => file.slice(0, -'project.json'.length).replace(/\/$/, '') || '.');
  const typed: string[] = [];
  const analyzed: string[] = [];
  const comments: string[] = [];
  const inferred = infersTypecheck(tree);
  for (const root of created.sort()) {
    const t = inferred ? 'none' : typecheckTargetChange(tree, root);
    if (t === 'added') typed.push(root);
    const a = analyzeTargetChange(tree, root);
    if (a === 'added') analyzed.push(root);
    if (t === 'comments' || a === 'comments') comments.push(`${root}/project.json`);
  }
  if (typed.length > 0) addTypecheckNxDefaults(tree);
  const script = hasTypecheckTargets(tree) ? addTypecheckScript(tree) : 'none';
  const code = (s: string) => `\`${s}\``;
  if (typed.length > 0) {
    data.notes.push(
      `typecheck target (tsc --noEmit) added to ${typed.map(code).join(', ')}; Angular ` +
        'projects also get `-c templates` (ngc --noEmit, templates checked).',
    );
  }
  if (analyzed.length > 0) {
    data.notes.push(`analyze target (flutter analyze) added to ${analyzed.map(code).join(', ')}.`);
  }
  if (comments.length > 0) {
    data.notes.push(
      `${comments.map(code).join(', ')} hold comments, so no typecheck/analyze target was ` +
        'written there; add it by hand.',
    );
  }
  if (script === 'added')
    data.notes.push(`Root npm script \`typecheck\`: ${code(TYPECHECK_SCRIPT)}.`);
  if (script === 'other') {
    data.notes.push(
      `The root \`typecheck\` npm script does something else; ${code(TYPECHECK_SCRIPT)} ` +
        'type-checks every project.',
    );
  }
}

/**
 * Source scripts the run copied that only strip EXIF from images or only type-check: what runs
 * them (npm scripts, run-commands targets, hooks, lint-staged, CI) runs pstack instead, and the
 * copies go (the source keeps them). `keep` (--keep-old-scripts) leaves them as copied.
 */
export function applyToolScripts(
  tree: Tree,
  originals: Originals,
  data: MigrationReportData,
  sourceDir: string,
  keep: boolean,
): void {
  const created = (f: string) => originals.has(f) && originals.get(f) === null;
  const moves = (data.moves ?? []).map((m) => ({
    from: path.relative(sourceDir, m.from).split(path.sep).join('/'),
    to: m.to,
  }));
  // A path written for the source repo → where the run put it.
  const mapPath = (p: string) => {
    for (const m of moves) {
      if (m.from === '' || m.from.startsWith('..')) continue;
      if (p === m.from) return m.to;
      if (p.startsWith(`${m.from}/`)) return `${m.to}/${p.slice(m.from.length + 1)}`;
    }
    return undefined;
  };
  const code = (s: string) => `\`${s}\``;
  if (keep) {
    return;
  }
  const outcomes = replaceToolScripts(tree, { only: created, mapPath });
  const replaced = outcomes.filter((o) => o.replaced).map((o) => o.script);
  // The replaced scripts and what only they load, when this run copied them.
  const live = liveScripts(tree);
  const removable = [...scriptClosure(tree, replaced)]
    .filter((f) => created(f) && !live.has(f))
    .sort();
  for (const f of removable) tree.delete(f);
  for (const o of outcomes) {
    const what = o.job === 'typecheck' ? 'type checking' : 'EXIF in source images';
    if (o.replaced) {
      data.notes.push(
        `${code(o.script)} (${what}) was not copied: ${o.rewritten
          .map((r) => {
            const [where, change] = r.split(': ');
            return `${where} runs ${code((change ?? '').split(' → ')[1] ?? '')}`;
          })
          .join('; ')} instead.`,
      );
    } else {
      data.notes.push(`${code(o.script)} (${what}) was copied as it is: ${o.left.join('; ')}.`);
    }
  }
  if (removable.length > 0 && removable.some((f) => !replaced.includes(f))) {
    data.notes.push(
      `Also not copied (only those scripts loaded them): ${removable
        .filter((f) => !replaced.includes(f))
        .map(code)
        .join(', ')}.`,
    );
  }
}
