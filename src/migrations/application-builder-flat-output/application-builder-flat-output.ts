import { logger, Tree } from '@nx/devkit';

import { keepJsonLayout, loadJsonc } from '../../lib/utils/json-layout';
import { projectJsonFiles } from '../../lib/utils/project-json-files';
import { POLYSTACK_BUILD_EXECUTOR } from '../../lib/utils/angular-project';
import { flattenApplicationOutput, outputBase, sameOutput } from '../../lib/release/flat-output';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * v1.11.11 (NX-113): release builds have no browser/ folder. Angular's application builder writes
 * the app to <base>/browser/ unless outputPath.browser is "", so the build target a release target
 * builds gets `outputPath: { base, browser: "" }` (a string outputPath becomes that object; none
 * at all, as Angular 20+ `ng new` writes, becomes the release outputPath as base). The
 * release build now refuses anything else. Layouts are kept; project.json files with comments,
 * server-rendered builds and release outputPaths that are not the build base are listed.
 */
export default async function applicationBuilderFlatOutput(tree: Tree): Promise<void> {
  const say = (s: string) => logger.info(`application-builder-flat-output: ${s}`);
  const jsonc = loadJsonc(tree.root);
  for (const file of projectJsonFiles(tree)) {
    const before = tree.read(file, 'utf8') ?? '';
    let pj: Json;
    try {
      pj = JSON.parse(before);
    } catch {
      if (/application"/.test(before) && before.includes(POLYSTACK_BUILD_EXECUTOR)) {
        say(`${file} holds comments; set its build outputPath.browser to "" by hand.`);
      }
      continue;
    }
    const targets = isObject(pj['targets']) ? pj['targets'] : {};
    const name = typeof pj['name'] === 'string' ? pj['name'] : '';
    let changed = false;
    for (const [releaseName, release] of Object.entries(targets)) {
      if (!isObject(release) || release['executor'] !== POLYSTACK_BUILD_EXECUTOR) continue;
      const options = isObject(release['options']) ? release['options'] : {};
      const ref =
        typeof options['buildTarget'] === 'string' ? options['buildTarget'] : `${name}:build`;
      const [project, buildName] = ref.split(':');
      if (project !== name || !buildName) continue;
      const build = targets[buildName];
      const releaseOut = options['outputPath'];
      const result = flattenApplicationOutput(
        build,
        typeof releaseOut === 'string' ? releaseOut : undefined,
      );
      if (result === 'ssr') {
        say(`${file} ${buildName}: server rendering; the release build refuses it.`);
        continue;
      }
      if (result === 'set') {
        changed = true;
        say(`${file} ${buildName}: outputPath.browser set to "" (no browser/ folder).`);
      }
      if (result !== 'none') {
        const base = outputBase(
          (build as Json)['options'] && ((build as Json)['options'] as Json)['outputPath'],
        );
        const out = options['outputPath'];
        if (base && typeof out === 'string' && !sameOutput(base, out)) {
          say(
            `${file} ${releaseName}: outputPath "${out}" is not the build base "${base}"; the ` +
              `release build refuses that. Set it to "${base}".`,
          );
        }
      }
    }
    if (!changed) continue;
    const after = JSON.stringify(pj, null, 2) + '\n';
    tree.write(file, (jsonc && keepJsonLayout(jsonc, before, after)) || after);
  }
}
