import { formatFiles, logger, Tree } from '@nx/devkit';

import { readProjects } from '../../lib/utils/project-json-files';
import {
  angularBuildTargetOf,
  ensureSharedLibs,
  wireSharedLibs,
} from '../../lib/utils/shared-libs';

import { SharedLibsGeneratorSchema } from './schema.d';

/** Creates the shared assets/styles folders when missing and wires them into Angular/Ionic apps. */
export default async function sharedLibsGenerator(
  tree: Tree,
  options: SharedLibsGeneratorSchema,
): Promise<void> {
  const named = (options.projects ?? []).map((p) => p.trim()).filter(Boolean);
  if (!!options.all === named.length > 0) {
    throw new Error('shared-libs generator: name the apps (projects) or pass all, one of them.');
  }
  const projects = readProjects(tree);
  const apps = projects.filter(
    (p) => p.json['projectType'] === 'application' && angularBuildTargetOf(p.json),
  );

  const problems: string[] = [];
  const selected = options.all
    ? apps
    : named.map((name) => {
        const p = projects.find((x) => x.name === name);
        if (!p) problems.push(`${name}: no such project`);
        else if (!apps.includes(p)) problems.push(`${name}: not an Angular/Ionic app`);
        return p;
      });
  if (problems.length > 0) throw new Error(`shared-libs generator: ${problems.join('; ')}.`);
  if (selected.length === 0) {
    logger.info('No Angular/Ionic apps found; nothing to wire.');
    return;
  }

  const libs = ensureSharedLibs(tree);
  for (const file of libs.created) logger.info(`created ${file}`);
  for (const note of libs.notes) logger.info(`Note: ${note}`);

  const wired: string[] = [];
  const already: string[] = [];
  for (const p of selected) {
    if (!p) continue;
    const json = p.json;
    const build = angularBuildTargetOf(json)!;
    if (wireSharedLibs(json, build, libs)) {
      tree.write(`${p.root}/project.json`, JSON.stringify(json, null, 2) + '\n');
      wired.push(p.name);
    } else {
      already.push(p.name);
    }
  }
  if (wired.length > 0) {
    logger.info(
      `shared assets (${libs.assets.dir} → assets/shared/) and styles (${libs.styles.dir}, ` +
        `@use 'theme';) wired into ${wired.join(', ')}.`,
    );
  }
  if (already.length > 0) logger.info(`already wired: ${already.join(', ')}.`);
  await formatFiles(tree);
}
