import { formatFiles, logger, readJson, Tree, writeJson } from '@nx/devkit';

import { buildProjectJson } from '../../generators/app/generator';
import { htaccessSourcePath } from '../../lib/release/htaccess';
import { adoptHtaccess, htaccessNote } from '../../lib/release/htaccess-adopt';
import { moveFlutterEnvFiles } from '../../lib/utils/env-files';
import { readProjects } from '../../lib/utils/project-json-files';

type Json = Record<string, unknown>;
type Targets = Record<string, Json>;

const RELEASE_EXECUTOR = '@mouryaamit/nx-polystack:build';
const FLUTTER_BUILD = '@mouryaamit/nx-polystack:flutter-build';

/** The workspace-local Flutter script targets of earlier workspaces, exactly as they were written. */
const RUN_COMMANDS_FLUTTER =
  /^node tools\/scripts\/flutter\/flutter-build\.js --project=(\S+) --target=(web|apk|ios|web-server) --env=\{args\.env\}$/;
/** The run-commands target name and its script --target, for each plugin target. */
const CONVERTED: Record<string, string> = {
  'build-web': 'web',
  'build-android': 'apk',
  'build-ios': 'ios',
  serve: 'web-server',
};

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface EnvFilesLayoutReport {
  /** "<app>: <what changed>" lines. */
  changes: string[];
  /** "<file>:<line>: <text>" references to old paths or invocations, for the user to update. */
  references: string[];
}

/**
 * v1.5.2: every per-environment file of a project lives in environments/<project>/.
 * - Angular/Ionic apps with a release target: the .htaccess their build copied becomes
 *   environments/<envProject>/htaccess.<env> for every release env (identical copies) and leaves
 *   the build assets; apps that built none get htaccess: false. Apps already on env files are kept.
 * - Flutter apps on nx:run-commands targets calling tools/scripts/flutter/flutter-build.js (the
 *   exact form earlier workspaces were given) get the plugin's flutter-build targets.
 * - Flutter apps on flutter-build: apps/<app>/env/<env>.json moves to
 *   environments/<envProject>/environment.<env>.json; build-web gets htaccess: false when the app
 *   has no htaccess.<env> files.
 * Existing files are never replaced. References to the old paths in package.json scripts, GitHub
 * workflows and Jenkinsfiles are listed, not rewritten.
 */
export default async function envFilesLayout(tree: Tree): Promise<void> {
  const report = migrateEnvFilesLayout(tree);
  // project.json files are written as JSON; keep them in the workspace's Prettier style. formatFiles
  // also sorts the root tsconfig's paths, which this migration does not touch: put it back.
  const rootTsconfigs = ['tsconfig.base.json', 'tsconfig.json'].flatMap((f) => {
    const content = tree.exists(f) ? tree.read(f) : null;
    return content ? [[f, content] as const] : [];
  });
  await formatFiles(tree);
  for (const [f, content] of rootTsconfigs) tree.write(f, content);
  for (const c of report.changes) logger.info(`env-files-layout: ${c}`);
  if (report.references.length > 0) {
    logger.warn(
      'env-files-layout: these still name the old paths or invocations; update them by hand:\n' +
        report.references.map((r) => `  ${r}`).join('\n'),
    );
  }
}

export function migrateEnvFilesLayout(tree: Tree): EnvFilesLayoutReport {
  const changes: string[] = [];
  const oldPaths: string[] = [];
  const argsTargets: string[] = [];
  /** Apps whose env files moved: direct calls of the old script no longer find them. */
  const scriptApps: string[] = [];

  for (const { name, root } of readProjects(tree)) {
    const file = `${root}/project.json`;
    const targetsOf = (): Targets => {
      const pj = readJson<Json>(tree, file);
      return isObject(pj['targets']) ? (pj['targets'] as Targets) : {};
    };

    // ── Angular / Ionic release builds ───────────────────────────────────────────
    if (Object.values(targetsOf()).some((t) => t?.['executor'] === RELEASE_EXECUTOR)) {
      const r = adoptHtaccess(tree, file);
      const notes: string[] = [];
      htaccessNote(r, name, notes);
      changes.push(...notes.map((n) => `${name}: ${n}`));
      if (r.source) oldPaths.push(r.source);
    }

    // ── Flutter on the workspace-local script ────────────────────────────────────
    const converted = convertRunCommandsFlutter(tree, file, name, root);
    if (converted.length > 0) {
      changes.push(
        `${name}: ${converted.join(', ')} now use the plugin's flutter-build executor ` +
          `(nx run ${name}:build-web:<env>; tools/scripts/flutter/flutter-build.js is no longer used by them)`,
      );
      argsTargets.push(...converted.map((t) => `${name}:${t}`));
    }

    // ── Flutter on flutter-build ─────────────────────────────────────────────────
    const targets = targetsOf();
    const flutter = Object.values(targets).filter((t) => t?.['executor'] === FLUTTER_BUILD);
    if (flutter.length === 0) continue;
    const web = targets['build-web'];
    const webOptions = isObject(web?.['options']) ? (web?.['options'] as Json) : undefined;
    const envProject =
      typeof webOptions?.['envProject'] === 'string' ? (webOptions['envProject'] as string) : name;
    const moved = moveFlutterEnvFiles(tree, root, envProject);
    if (moved.moved.length > 0) {
      changes.push(
        `${name}: env files moved to environments/${envProject}/ ` +
          `(${moved.moved.map(([from, to]) => `${from} → ${to}`).join(', ')})`,
      );
      oldPaths.push(`${root}/env/`);
      scriptApps.push(name);
    }
    if (moved.kept.length > 0) {
      changes.push(
        `${name}: kept ${moved.kept.join(
          ', ',
        )}: environments/${envProject}/ already has that env ` +
          '(compare them and delete the old one)',
      );
    }
    if (web && webOptions?.['htaccess'] === undefined) {
      const envs = Object.entries(
        isObject(web['configurations']) ? (web['configurations'] as Json) : {},
      ).map(([c, conf]) => String((isObject(conf) ? conf['env'] : undefined) ?? c).toLowerCase());
      if (!envs.some((env) => tree.exists(htaccessSourcePath(envProject, env)))) {
        const pj = readJson<Json>(tree, file);
        const pjWeb = (pj['targets'] as Targets)['build-web'];
        pjWeb['options'] = {
          ...(isObject(pjWeb['options']) ? pjWeb['options'] : {}),
          htaccess: false,
        };
        writeJson(tree, file, pj);
        changes.push(
          `${name}: build-web makes no .htaccess (htaccess: false: the app had none); for one, add ` +
            `environments/${envProject}/htaccess.<env> for each env and remove the option`,
        );
      }
    }
  }

  return { changes, references: findReferences(tree, oldPaths, argsTargets, scriptApps) };
}

/**
 * Replaces build-web/build-android/build-ios/serve targets that are exactly the earlier
 * `node tools/scripts/flutter/flutter-build.js --project=<app> --target=… --env={args.env}` commands
 * (and whose project is the app at apps/<app>) with the targets pstack app --type=flutter writes.
 * Returns the converted target names.
 */
function convertRunCommandsFlutter(tree: Tree, file: string, name: string, root: string): string[] {
  const pj = readJson<Json>(tree, file);
  const targets = isObject(pj['targets']) ? (pj['targets'] as Targets) : {};
  const generated = (buildProjectJson(name, { root, exportTarget: false }) as { targets: Targets })
    .targets;
  const converted: string[] = [];
  for (const [targetName, scriptTarget] of Object.entries(CONVERTED)) {
    const t = targets[targetName];
    if (!t || t['executor'] !== 'nx:run-commands' || !isObject(t['options'])) continue;
    const m = RUN_COMMANDS_FLUTTER.exec(String(t['options']['command'] ?? ''));
    if (!m || m[2] !== scriptTarget || `apps/${m[1]}` !== root) continue;
    targets[targetName] = generated[targetName];
    converted.push(targetName);
  }
  if (converted.length > 0) writeJson(tree, file, pj);
  return converted;
}

/** Files that name an old path, or pass --args to a converted target, with line numbers. */
function findReferences(
  tree: Tree,
  oldPaths: string[],
  argsTargets: string[],
  scriptApps: string[],
): string[] {
  if (oldPaths.length === 0 && argsTargets.length === 0) return [];
  // The workspace-local script reads apps/<app>/env/<env>.json, and skips a missing one silently.
  const scriptCalls = scriptApps.map(
    (app) =>
      new RegExp(
        `tools/scripts/flutter/flutter-build\\.js\\s[^"']*--project=${app.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        )}(?![\\w-])`,
      ),
  );
  const files = ['package.json', ...workflowFiles(tree), ...jenkinsFiles(tree)];
  const out: string[] = [];
  for (const f of files) {
    if (!tree.exists(f)) continue;
    const lines = (tree.read(f, 'utf-8') ?? '').split('\n');
    lines.forEach((line, i) => {
      const hit =
        oldPaths.some((p) => line.includes(p)) ||
        argsTargets.some((t) => line.includes(`nx run ${t} `) && line.includes('--args=')) ||
        scriptCalls.some((re) => re.test(line));
      if (hit) out.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return out;
}

function workflowFiles(tree: Tree, dir = '.github'): string[] {
  if (!tree.exists(dir) || tree.isFile(dir)) return [];
  return tree.children(dir).flatMap((c) => {
    const rel = `${dir}/${c}`;
    if (!tree.isFile(rel)) return workflowFiles(tree, rel);
    return /\.ya?ml$/.test(c) ? [rel] : [];
  });
}

function jenkinsFiles(tree: Tree): string[] {
  return tree.children('').filter((c) => /^Jenkinsfile/.test(c) && tree.isFile(c));
}
