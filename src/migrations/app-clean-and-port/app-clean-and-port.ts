import { formatFiles, logger, Tree } from '@nx/devkit';

import { cleanPathProblem } from '../../executors/clean/executor';
import { cleanTarget } from '../../lib/utils/angular-project';
import { readProjects } from '../../lib/utils/project-json-files';
import {
  DEFAULT_SERVE_PORT,
  explicitPort,
  nextFreePort,
  serveTargetOf,
} from '../../lib/utils/serve-port';
import { angularBuildTargetOf } from '../../lib/utils/shared-libs';

type Target = { executor?: string; options?: Record<string, unknown> };

/**
 * v0.35.0: apps get a `clean` target when they have none, and apps whose dev servers fall back to
 * port 4200 get distinct ports: the first by name keeps 4200 unless another app sets it
 * explicitly; explicit ports (numbers or numeric strings) are kept.
 */
export default async function appCleanAndPort(tree: Tree): Promise<void> {
  let projects;
  try {
    projects = readProjects(tree);
  } catch (err) {
    logger.warn(`app-clean-and-port: skipped (${(err as Error).message}).`);
    return;
  }
  const apps = projects
    .filter((p) => p.json['projectType'] === 'application' && serveTargetOf(p.json))
    .sort((a, b) => a.name.localeCompare(b.name));

  const cleaned: string[] = [];
  const skipped: string[] = [];
  const ported: string[] = [];
  const touched = new Set<string>();

  for (const app of apps) {
    const targets = (app.json['targets'] ?? {}) as Record<string, Target>;
    if (targets['clean']) continue;
    const serve = serveTargetOf(app.json) as Target;
    const flutter = serve.executor === '@mouryaamit/nx-polystack:flutter-build';
    const build = flutter ? undefined : angularBuildTargetOf(app.json);
    const outputPath = build?.options?.['outputPath'];
    let outputs: string[] | undefined;
    if (typeof outputPath === 'string' && outputPath.trim() !== '') {
      const out = outputPath.trim().replace(/\/+$/, '');
      if (cleanPathProblem(out, app.root) === null) outputs = [out];
      else skipped.push(`${app.name} (${out})`);
    }
    const target = cleanTarget(app.root, { flutter, outputs, name: app.name });
    target.options.paths = target.options.paths.filter(
      (p) => cleanPathProblem(p, app.root) === null,
    );
    targets['clean'] = target;
    app.json['targets'] = targets;
    cleaned.push(app.name);
    touched.add(app.name);
  }

  const portOfApp = (a: (typeof apps)[number]) => explicitPort(serveTargetOf(a.json) as Target);
  const used = apps.map(portOfApp).filter((p): p is number => p !== undefined);
  let first = true;
  for (const app of apps.filter((a) => portOfApp(a) === undefined)) {
    if (first && !used.includes(DEFAULT_SERVE_PORT)) {
      used.push(DEFAULT_SERVE_PORT);
      first = false;
      continue;
    }
    first = false;
    const port = nextFreePort(used);
    used.push(port);
    const serve = serveTargetOf(app.json) as Target;
    serve.options = { ...(serve.options ?? {}), port };
    ported.push(`${app.name} → ${port}`);
    touched.add(app.name);
  }

  for (const app of apps) {
    if (!touched.has(app.name)) continue;
    tree.write(`${app.root}/project.json`, JSON.stringify(app.json, null, 2) + '\n');
  }
  if (cleaned.length > 0) {
    logger.info(`app-clean-and-port: clean target added to ${cleaned.join(', ')}.`);
  }
  if (skipped.length > 0) {
    logger.info(
      'app-clean-and-port: build outputs left out of clean (not below dist/, coverage/ or tmp/, ' +
        `nor an output folder of the project): ${skipped.join(', ')}.`,
    );
  }
  if (ported.length > 0) {
    logger.info(
      `app-clean-and-port: these apps served on 4200; dev-server ports set: ${ported.join(
        ', ',
      )}. ` + 'Update local OAuth redirect URIs or CORS allowlists that name localhost:4200.',
    );
  }
  if (touched.size > 0) await formatFiles(tree);
}
