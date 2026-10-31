import { logger, Tree } from '@nx/devkit';

import { scanProjects } from '../../lib/utils/project-json-files';
import {
  addTypecheckNxDefaults,
  addTypecheckScript,
  analyzeTargetChange,
  hasTypecheckTargets,
  infersTypecheck,
  templatesConfigChange,
  TYPECHECK_SCRIPT,
  typecheckTargetChange,
} from '../../lib/utils/quality';

/**
 * v1.12.0 (NX-111): type checking in every project, not only those that existed at 0.36.0.
 * - `typecheck` (tsc --noEmit -p tsconfig.app/lib.json) on projects without one; Angular ones also
 *   get the `templates` configuration (ngc --noEmit), also added to typecheck targets pstack wrote;
 * - `analyze` (flutter analyze) on Flutter projects without one;
 * - typecheck cached in nx.json, and the root `typecheck` npm script.
 * project.json layouts are kept; project.json files with comments are listed, not rewritten.
 * Workspaces whose nx.json infers typecheck (@nx/js/typescript) get no typecheck targets.
 */
export default async function typecheckEverywhere(tree: Tree): Promise<void> {
  const typed: string[] = [];
  const templates: string[] = [];
  const analyzed: string[] = [];
  const comments: string[] = [];
  const inferred = infersTypecheck(tree);
  for (const p of scanProjects(tree)) {
    const changes = [
      inferred ? 'none' : typecheckTargetChange(tree, p.root),
      inferred ? 'none' : templatesConfigChange(tree, p.root),
      analyzeTargetChange(tree, p.root),
    ];
    if (changes[0] === 'added') typed.push(p.name);
    if (changes[1] === 'added' && changes[0] !== 'added') templates.push(p.name);
    if (changes[2] === 'added') analyzed.push(p.name);
    if (changes.includes('comments')) comments.push(`${p.root}/project.json`);
  }
  const cached = typed.length > 0 && addTypecheckNxDefaults(tree);
  const script = hasTypecheckTargets(tree) ? addTypecheckScript(tree) : 'none';

  const say = (s: string) => logger.info(`typecheck-everywhere: ${s}`);
  if (inferred) say('nx.json infers typecheck targets (@nx/js/typescript); none were added.');
  if (typed.length > 0) {
    say(
      `typecheck target added to ${typed.join(', ')}. Run npx nx run-many -t typecheck once ` +
        'before merging.',
    );
  }
  if (templates.length > 0) {
    say(
      `typecheck:templates (ngc --noEmit, templates checked) added to ${templates.join(', ')}; ` +
        'run npx nx run-many -t typecheck -c templates.',
    );
  }
  if (analyzed.length > 0) say(`analyze target (flutter analyze) added to ${analyzed.join(', ')}.`);
  if (comments.length > 0) {
    say(`${comments.join(', ')} hold comments and were not rewritten; add the targets by hand.`);
  }
  if (cached) say('typecheck is cached (nx.json targetDefaults).');
  if (script === 'added') say(`root npm script "typecheck": ${TYPECHECK_SCRIPT}.`);
  if (script === 'other') {
    say(
      `the root "typecheck" npm script does something else; ${TYPECHECK_SCRIPT} checks every project.`,
    );
  }
}
