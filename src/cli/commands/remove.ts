import * as fs from 'fs';
import * as path from 'path';

import { Tree } from '@nx/devkit';

import { refreshLlmBlocks } from '../../lib/utils/llm-block';
import { flagBoolean, flagString } from '../args';
import { findWorkspaceRoot } from '../context';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';
import { defaultUpgradeDeps, UpgradeDeps } from './upgrade';
import { AngularProject, workspaceProjects } from './upgrade-standalone';

/*
 * pstack remove --app=<a,b> [--dry-run] [--yes] [--force]: retires apps. Deletes each app's folder
 * (with an <app>-e2e project), its env files, tsconfig path, npm scripts, nx.json encryption keys,
 * migration report and dist output; uninstalls runtime packages nothing else uses; refreshes the
 * llm blocks. Shared libraries are never removed (listed when only these apps used them).
 * Needs a clean git tree; tags the last commit with the app as retired/<app>, then one commit.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Runtime packages that are never uninstalled: frameworks, the plugin and its pipeline. */
const NEVER_REMOVE = [
  /^@angular\//,
  /^@angular-devkit\//,
  /^@nx\//,
  /^@nrwl\//,
  /^nx$/,
  /^typescript$/,
  /^tslib$/,
  /^rxjs$/,
  /^zone\.js$/,
  /^@ionic\/angular$/,
  /^@ionic\/core$/,
  /^ionicons$/,
  /^@capacitor\/(core|cli)$/,
  /^@mouryaamit\/nx-polystack$/,
  /^crypto-js$/,
];

export interface RemovalApp {
  name: string;
  root: string;
  /** Other folders that go with the app: <app>-e2e, environments/<envProject>, the report. */
  extraDirs: string[];
  files: string[];
  /** tsconfig.base.json paths that point into the app. */
  aliases: string[];
  envProject: string;
  /** dist folders (not in git). */
  dist: string[];
}

export interface RemovalPlan {
  apps: RemovalApp[];
  /** npm scripts removed (name → command). */
  scripts: Record<string, string>;
  /** npm scripts that name an app and another project: kept, listed. */
  sharedScripts: string[];
  /** Runtime packages uninstalled, with why. */
  packages: { name: string; why: string }[];
  /** Runtime packages the apps use that stay, with why. */
  keptPackages: { name: string; why: string }[];
  /** Libraries only these apps import (kept). */
  libsOnlyHere: string[];
  /** Projects that depend on an app (refused without --force). */
  dependents: string[];
  /** Lines in CI files and README that name an app (not edited). */
  mentions: string[];
}

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|scss|sass|css|less|html|ya?ml)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'tmp', 'coverage', '.git', '.nx', '.angular']);

/** Text files under `dir` (relative to root), skipping build output and the given folders. */
function textFiles(root: string, dir: string, skip: Set<string>): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || skip.has(r) || e.name === 'android' || e.name === 'ios')
          continue;
        walk(r);
      } else if (TEXT.test(e.name) && e.name !== 'package-lock.json') {
        out.push(r);
      }
    }
  };
  walk(dir);
  return out;
}

const read = (root: string, rel: string): string => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
};

const readJson = (root: string, rel: string): Json => {
  try {
    const v = JSON.parse(read(root, rel));
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
};

/** Package names a file imports or names (import/require/export from, @import/@use, node_modules/). */
function packagesIn(text: string): Set<string> {
  const found = new Set<string>();
  const add = (spec: string) => {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@env/')) return;
    const parts = spec.replace(/^~/, '').split('/');
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) found.add(name);
  };
  for (const m of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|@(?:import|use|forward)\s+)['"]([^'"]+)['"]/g,
  )) {
    add(m[1]);
  }
  for (const m of text.matchAll(/node_modules\/((?:@[\w.-]+\/)?[\w.-]+)/g)) add(m[1]);
  return found;
}

/** Plans removing these apps; nothing is changed. */
export function planRemoval(root: string, names: string[]): RemovalPlan {
  const projects = workspaceProjects(root);
  const unknown = names.filter((n) => !projects.some((p) => p.name === n));
  if (unknown.length > 0) {
    throw new CliError(
      `no app named ${unknown.map((n) => `"${n}"`).join(', ')}. Apps: ${projects
        .filter((p) => p.app)
        .map((p) => p.name)
        .join(', ')}.`,
    );
  }
  const libs = names.filter((n) => !projects.find((p) => p.name === n)?.app);
  if (libs.length > 0) {
    throw new CliError(`${libs.join(', ')}: not an app (pstack remove retires apps only).`);
  }

  const tsPaths = (() => {
    const co = readJson(root, 'tsconfig.base.json')['compilerOptions'];
    return isObject(co) && isObject(co['paths']) ? (co['paths'] as Json) : {};
  })();
  const aliasesInto = (dir: string) =>
    Object.entries(tsPaths)
      .filter(
        ([, t]) =>
          Array.isArray(t) &&
          t.some(
            (x) => typeof x === 'string' && `${x.replace(/^\.\//, '')}/`.startsWith(`${dir}/`),
          ),
      )
      .map(([alias]) => alias);
  const releaseOf = (p: AngularProject): Json | undefined => {
    const targets = readJson(root, `${p.root}/project.json`)['targets'];
    if (!isObject(targets)) return undefined;
    return Object.values(targets).find(
      (t): t is Json => isObject(t) && t['executor'] === '@mouryaamit/nx-polystack:build',
    );
  };
  const envProjectOf = (p: AngularProject) => {
    const o = releaseOf(p)?.['options'];
    return isObject(o) && typeof o['envProject'] === 'string' ? o['envProject'] : p.name;
  };

  const removed = projects.filter(
    (p) => names.includes(p.name) || names.some((n) => p.name === `${n}-e2e`),
  );
  const removedRoots = new Set(removed.map((p) => p.root));
  const kept = projects.filter((p) => !removedRoots.has(p.root));

  const apps: RemovalApp[] = names.map((name) => {
    const p = projects.find((x) => x.name === name) as AngularProject;
    const envProject = envProjectOf(p);
    const envShared = kept.some((k) => envProjectOf(k) === envProject && k.app);
    const extraDirs = [
      ...removed.filter((x) => x.name === `${name}-e2e`).map((x) => x.root),
      ...(!envShared && fs.existsSync(path.join(root, 'environments', envProject))
        ? [`environments/${envProject}`]
        : []),
    ];
    const files = [`docs/migrations/${name}.md`, `docs/migrations/${name}.manifest.json`].filter(
      (f) => fs.existsSync(path.join(root, f)),
    );
    const dist = [`dist/${p.root}`, `dist/apps/${name}`].filter(
      (d, i, a) => a.indexOf(d) === i && fs.existsSync(path.join(root, d)),
    );
    return { name, root: p.root, extraDirs, files, aliases: aliasesInto(p.root), envProject, dist };
  });
  const goneDirs = new Set(apps.flatMap((a) => [a.root, ...a.extraDirs]));

  // Who still uses an app: imports of its aliases, implicitDependencies, target references.
  const dependents: string[] = [];
  const keptFiles = new Map(kept.map((k) => [k, textFiles(root, k.root, goneDirs)]));
  for (const a of apps) {
    for (const k of kept) {
      const pj = readJson(root, `${k.root}/project.json`);
      const why: string[] = [];
      if (Array.isArray(pj['implicitDependencies']) && pj['implicitDependencies'].includes(a.name))
        why.push('implicitDependencies');
      if (JSON.stringify(pj['targets'] ?? {}).includes(`"${a.name}:`)) why.push('a target');
      const importer = (keptFiles.get(k) ?? []).find((f) =>
        a.aliases.some((al) => new RegExp(`['"]${esc(al)}(/[^'"]*)?['"]`).test(read(root, f))),
      );
      if (importer) why.push(`imports it in ${importer}`);
      if (why.length > 0) dependents.push(`${k.name} → ${a.name} (${why.join(', ')})`);
    }
  }

  // Libraries the apps import that no kept project imports.
  const libAliases = kept
    .filter((k) => !k.app)
    .map((l) => ({ lib: l, aliases: aliasesInto(l.root) }))
    .filter((x) => x.aliases.length > 0);
  const imports = (files: string[], aliases: string[]) =>
    files.some((f) =>
      aliases.some((al) => new RegExp(`['"]${esc(al)}(/[^'"]*)?['"]`).test(read(root, f))),
    );
  const appFiles = apps.flatMap((a) => textFiles(root, a.root, new Set()));
  const libsOnlyHere = libAliases
    .filter(
      ({ lib, aliases }) =>
        imports(appFiles, aliases) &&
        !kept.some((k) => k.root !== lib.root && imports(keptFiles.get(k) ?? [], aliases)),
    )
    .map(({ lib }) => lib.name)
    .sort();

  // Runtime packages: the apps use them, nothing else names them.
  const pkg = readJson(root, 'package.json');
  const runtime = isObject(pkg['dependencies']) ? Object.keys(pkg['dependencies']) : [];
  const used = new Set<string>();
  for (const f of appFiles) for (const n of packagesIn(read(root, f))) used.add(n);
  const elsewhere = textFiles(root, '', goneDirs).filter(
    (f) => f !== 'package.json' && !f.startsWith('docs/migrations/'),
  );
  const packages: { name: string; why: string }[] = [];
  const keptPackages: { name: string; why: string }[] = [];
  for (const name of runtime.filter((n) => used.has(n)).sort()) {
    if (NEVER_REMOVE.some((re) => re.test(name))) {
      keptPackages.push({ name, why: 'framework or pipeline package' });
      continue;
    }
    const re = new RegExp(`['"\`~/]${esc(name)}(['"\`/]|$)`, 'm');
    const other = elsewhere.find((f) => re.test(read(root, f)));
    if (other) keptPackages.push({ name, why: `also named in ${other}` });
    else packages.push({ name, why: `only ${apps.map((a) => a.name).join(', ')} use it` });
  }

  // npm scripts: those for the apps only.
  const scripts: Record<string, string> = {};
  const sharedScripts: string[] = [];
  const pkgScripts = isObject(pkg['scripts']) ? (pkg['scripts'] as Record<string, unknown>) : {};
  const refers = (cmd: string, n: string, root_: string) =>
    new RegExp(`(^|[\\s'"=/])${esc(n)}:`).test(cmd) || cmd.includes(`${root_}/`);
  for (const [s, cmd] of Object.entries(pkgScripts)) {
    if (typeof cmd !== 'string') continue;
    const mine = apps.some((a) => s.split(':').includes(a.name) || refers(cmd, a.name, a.root));
    if (!mine) continue;
    const others = kept.some((k) => refers(cmd, k.name, k.root));
    if (others) sharedScripts.push(s);
    else scripts[s] = cmd;
  }

  // Mentions in CI files and the README (listed, not edited).
  const mentions: string[] = [];
  const ciFiles = [
    'README.md',
    'Jenkinsfile',
    ...(fs.existsSync(path.join(root, '.github/workflows'))
      ? fs.readdirSync(path.join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`)
      : []),
  ];
  for (const f of ciFiles) {
    read(root, f)
      .split('\n')
      .forEach((line, i) => {
        if (apps.some((a) => new RegExp(`(^|[^\\w-])${esc(a.name)}([^\\w-]|$)`).test(line))) {
          mentions.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
  }

  return {
    apps,
    scripts,
    sharedScripts: sharedScripts.sort(),
    packages,
    keptPackages,
    libsOnlyHere,
    dependents,
    mentions,
  };
}

/** The plan as lines for the console. */
export function describePlan(plan: RemovalPlan): string[] {
  const out: string[] = [];
  for (const a of plan.apps) {
    out.push(`Remove app ${a.name}:`);
    for (const d of [a.root, ...a.extraDirs]) out.push(`  delete ${d}/`);
    for (const f of a.files) out.push(`  delete ${f}`);
    for (const d of a.dist) out.push(`  delete ${d}/ (build output)`);
    for (const al of a.aliases) out.push(`  tsconfig.base.json: path ${al}`);
    out.push(`  nx.json: pstack.envEncryption.keys.${a.envProject} (if set)`);
  }
  const scripts = Object.keys(plan.scripts);
  if (scripts.length > 0) out.push(`npm scripts removed: ${scripts.join(', ')}`);
  if (plan.packages.length > 0) {
    out.push('npm packages uninstalled:');
    for (const p of plan.packages) out.push(`  ${p.name} (${p.why})`);
  }
  if (plan.keptPackages.length > 0) {
    out.push('npm packages kept:');
    for (const p of plan.keptPackages) out.push(`  ${p.name} (${p.why})`);
  }
  if (plan.libsOnlyHere.length > 0) {
    out.push(
      `Libraries only these apps used (kept; retire them yourself if unused): ${plan.libsOnlyHere.join(
        ', ',
      )}`,
    );
  }
  if (plan.sharedScripts.length > 0) {
    out.push(`npm scripts kept (they name other projects too): ${plan.sharedScripts.join(', ')}`);
  }
  if (plan.mentions.length > 0) {
    out.push('Mentions to update by hand:');
    for (const m of plan.mentions) out.push(`  ${m}`);
  }
  if (plan.dependents.length > 0) {
    out.push('Projects that depend on these apps:');
    for (const d of plan.dependents) out.push(`  ${d}`);
  }
  return out;
}

/** The plan's file changes on a tree (folders, tsconfig paths, npm scripts, nx.json keys). */
export function applyRemoval(tree: Tree, plan: RemovalPlan): void {
  for (const a of plan.apps) {
    for (const d of [a.root, ...a.extraDirs]) tree.delete(d);
    for (const f of a.files) tree.delete(f);
  }
  const edit = (file: string, fn: (json: Json) => void) => {
    if (!tree.exists(file)) return;
    const json = JSON.parse(tree.read(file, 'utf8') ?? '{}') as Json;
    const before = JSON.stringify(json);
    fn(json);
    if (JSON.stringify(json) !== before) tree.write(file, JSON.stringify(json, null, 2) + '\n');
  };
  edit('tsconfig.base.json', (json) => {
    const co = json['compilerOptions'];
    if (!isObject(co) || !isObject(co['paths'])) return;
    for (const a of plan.apps) for (const al of a.aliases) delete (co['paths'] as Json)[al];
  });
  edit('package.json', (json) => {
    if (!isObject(json['scripts'])) return;
    for (const s of Object.keys(plan.scripts)) delete (json['scripts'] as Json)[s];
  });
  edit('nx.json', (json) => {
    const enc = isObject(json['pstack']) ? (json['pstack'] as Json)['envEncryption'] : undefined;
    const keys = isObject(enc) ? enc['keys'] : undefined;
    if (!isObject(keys)) return;
    for (const a of plan.apps) delete keys[a.envProject];
  });
  refreshLlmBlocks(tree);
}

/** pstack remove --app=<a,b> [--dry-run] [--yes] [--force] */
export async function runRemove(
  ctx: CommandContext,
  deps: UpgradeDeps = defaultUpgradeDeps,
): Promise<number> {
  const root = findWorkspaceRoot(ctx.cwd);
  if (!root) throw new CliError('run "pstack remove" inside an Nx workspace.');
  if (ctx.flags['app'] === true || !flagString(ctx.flags, 'app')) {
    throw new CliError('pass the apps to retire: pstack remove --app=<name>[,<name>…]');
  }
  const names = [
    ...new Set(
      (flagString(ctx.flags, 'app') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const plan = planRemoval(root, names);
  for (const line of describePlan(plan)) deps.log(line);
  if (plan.dependents.length > 0 && !flagBoolean(ctx.flags, 'force')) {
    throw new CliError(
      'other projects depend on these apps (listed above); fix them, or pass --force to remove anyway.',
    );
  }
  if (ctx.dryRun) {
    deps.log('\nDry run: nothing was changed.');
    return 0;
  }
  const status = deps.gitStatus(root);
  if (status === null) throw new CliError('pstack remove needs a git repository (one commit).');
  if (status.trim() !== '') throw new CliError('commit or stash your changes first.');
  if (!flagBoolean(ctx.flags, 'yes')) {
    if (!deps.interactive) throw new CliError('pass --yes to remove without asking.');
    const prompter = deps.prompter();
    const answer = await prompter.ask(`\nRemove ${names.join(', ')}? (yes/no)`, 'no');
    prompter.close();
    if (!/^y(es)?$/i.test(answer)) {
      deps.log('Nothing removed.');
      return 1;
    }
  }

  // The last commit that still has the app, easy to find later.
  for (const n of names) {
    const tag = `retired/${n}`;
    const exists = deps.capture?.('git', ['tag', '--list', tag], root).trim() === tag;
    if (exists) deps.log(`  tag ${tag} exists already; not moved`);
    else deps.exec('git', ['tag', tag], root);
  }
  await runInTree(root, { dryRun: false, verbose: ctx.verbose, quietWhenUnchanged: true }, (tree) =>
    applyRemoval(tree, plan),
  );
  for (const a of plan.apps) {
    for (const d of a.dist) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  }
  if (plan.packages.length > 0) {
    deps.exec('npm', ['uninstall', ...plan.packages.map((p) => p.name)], root);
  }
  deps.exec('git', ['add', '-A'], root);
  const body = [
    ...(plan.packages.length > 0
      ? [`npm packages uninstalled: ${plan.packages.map((p) => p.name).join(', ')}`]
      : []),
    ...(plan.libsOnlyHere.length > 0
      ? [`Libraries only it used: ${plan.libsOnlyHere.join(', ')}`]
      : []),
    `The app is at tag ${names.map((n) => `retired/${n}`).join(', ')}.`,
  ];
  deps.exec(
    'git',
    [
      'commit',
      '-m',
      `chore: remove app ${names.join(', ')} (pstack remove)`,
      '-m',
      body.join('\n'),
    ],
    root,
  );
  deps.log(`\n✔ Removed ${names.join(', ')}. Undo with: git revert HEAD`);
  return 0;
}
