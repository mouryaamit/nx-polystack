import type { Tree } from '@nx/devkit';

import { APP_ID_RE, BaseApp, defaultAppId, describeBaseApp } from '../../generators/app/from';
import { appRoot, NAME_RE, parseDir } from '../../lib/utils/app-dir';
import { checkBaseHref } from '../../lib/utils/base-href';
import { fsTree } from '../../lib/utils/nx-tree';
import { scanProjects } from '../../lib/utils/project-json-files';
import { nextFreePort, portProblem, usedServePorts } from '../../lib/utils/serve-port';
import { flagBoolean, flagString } from '../args';
import { askValid, isInteractive, Prompter, terminalPrompter } from '../prompt';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { AppDeps, requireWorkspace } from './app';

/** Flags of `pstack app` that come from the base app with --from. */
const NOT_WITH_FROM = ['type', 'i18n', 'push', 'deeplink', 'envLayout', 'cspConnectSrc'];

const list = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const kebab = (flag: string) => flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

interface Answers {
  name?: string;
  dir?: string;
  port?: number;
  /** null: none. */
  baseHref?: string | null;
  appId?: string;
  envs?: string[];
  csp?: 'keep' | 'clear';
  tags?: string[];
}

function valueFlag(ctx: CommandContext, key: string, example: string): string | undefined {
  if (ctx.flags[key] === true)
    throw new CliError(`--${kebab(key)} needs a value, e.g. ${example}.`);
  return flagString(ctx.flags, key);
}

/** pstack app --from=<app>: a new app from an existing one (NX-66). */
export async function runAppFrom(ctx: CommandContext, deps: AppDeps): Promise<number> {
  const from = valueFlag(ctx, 'from', '--from=web');
  if (!from) throw new CliError('--from needs the name of an app, e.g. --from=web.');
  for (const flag of NOT_WITH_FROM) {
    if (ctx.flags[flag] !== undefined) {
      throw new CliError(
        `--${kebab(flag)} does not apply with --from (the new app takes it from ${from}).`,
      );
    }
  }

  // Flags, checked before anything is read.
  const given: Answers = {};
  given.name = valueFlag(ctx, 'name', '--name=partner-portal');
  const dir = valueFlag(ctx, 'dir', '--dir=legacy');
  if (dir !== undefined)
    given.dir = dir === '.' ? '.' : (checked(() => parseDir(dir, 'app')) as string);
  const port = valueFlag(ctx, 'port', '--port=4210');
  if (port !== undefined) {
    const n = /^\d+$/.test(port) ? Number(port) : NaN;
    const problem = portProblem(n);
    if (problem) throw new CliError(problem.replace(/\(got NaN\)/, `(got ${port})`) + '.');
    given.port = n;
  }
  const href = valueFlag(ctx, 'baseHref', '--base-href=/portal/ or --base-href=none');
  if (href !== undefined) {
    given.baseHref = href === 'none' ? null : (checked(() => checkBaseHref(href)) as string);
  }
  given.appId = valueFlag(ctx, 'appId', '--app-id=com.acme.portal');
  const envs = valueFlag(ctx, 'envs', '--envs=dev,uat,prod');
  if (envs !== undefined) given.envs = list(envs);
  const csp = valueFlag(ctx, 'csp', '--csp=keep');
  if (csp !== undefined) {
    if (csp !== 'keep' && csp !== 'clear') throw new CliError('--csp must be keep or clear.');
    given.csp = csp;
  }
  const tags = valueFlag(ctx, 'tags', '--tags=scope:partner');
  if (tags !== undefined) given.tags = list(tags);
  const yes = flagBoolean(ctx.flags, 'yes') || flagBoolean(ctx.flags, 'y');

  const root = requireWorkspace(ctx.cwd, 'app');
  const tree = fsTree(root);
  const base = checked(() => describeBaseApp(tree, from)) as BaseApp;
  const interactive = deps.interactive ?? (!yes && isInteractive());
  // Flag values the questions would not ask again are checked now, not after them.
  if (given.name !== undefined && !NAME_RE.test(given.name)) {
    throw new CliError(`--name="${given.name}" must be kebab-case (e.g. partner-portal).`);
  }
  const unknownEnvs = (given.envs ?? []).filter((e) => !base.envs.includes(e));
  if (unknownEnvs.length > 0) {
    throw new CliError(
      `${base.name} has no environment ${unknownEnvs.join(', ')} (it has ${base.envs.join(', ')}).`,
    );
  }

  let answers: Answers = given;
  if (interactive) {
    const prompter = deps.prompter ?? terminalPrompter();
    try {
      answers = await ask(tree, base, given, prompter);
      summary(base, answers).forEach((l) => console.log(l));
      const ok = await prompter.ask(`Create ${answers.name}? (Y/n)`, 'y');
      if (!/^y(es)?$/i.test(ok)) {
        console.log('Nothing was changed.');
        return 0;
      }
    } finally {
      prompter.close();
    }
  } else if (!given.name) {
    throw new CliError(
      '--name is required with --from (or run pstack app --from in a terminal to be asked).\n\n' +
        `Example: pstack app --from=${from} --name=partner-portal --yes`,
    );
  }

  const { default: appGenerator } = await import('../../generators/app/generator');
  await runInTree(root, ctx, (t) =>
    appGenerator(t, {
      from,
      name: answers.name as string,
      type: base.type,
      dir: answers.dir,
      port: answers.port,
      baseHref: answers.baseHref === null ? 'none' : answers.baseHref,
      appId: answers.appId,
      envs: answers.envs,
      csp: answers.csp,
      tags: answers.tags,
    }),
  );
  return 0;
}

function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new CliError((err as Error).message.replace(/^app( --from)?: /, ''));
  }
}

/** The questions for what was not given as a flag (base app values as defaults). */
async function ask(tree: Tree, base: BaseApp, given: Answers, p: Prompter): Promise<Answers> {
  const a: Answers = { ...given };
  const projects = new Set(scanProjects(tree).map((x) => x.name));
  const folderProblem = (name: string, dir: string | undefined) => {
    const r = appRoot(name, dir === '.' ? undefined : dir);
    return tree.exists(r) ? `${r} already exists` : undefined;
  };

  if (!a.name) {
    a.name = await askValid(p, 'New app name', undefined, (v) => {
      if (!NAME_RE.test(v)) return 'kebab-case, e.g. partner-portal';
      if (v === base.name || projects.has(v)) return `a project named ${v} already exists`;
      return a.dir !== undefined ? folderProblem(v, a.dir) : undefined;
    });
  }
  const name = a.name;
  if (given.dir === undefined) {
    // The app's own folder under apps/ (default apps/[<base folder>/]<name>); it ends with the name.
    const dirOf = (v: string) =>
      v
        .replace(/^apps\//, '')
        .replace(/\/+$/, '')
        .split('/')
        .slice(0, -1)
        .join('/');
    const answer = await askValid(
      p,
      'App folder under apps/',
      base.dir ? `${base.dir}/${name}` : name,
      (v) => {
        const path = v.replace(/^apps\//, '').replace(/\/+$/, '');
        if (path.split('/').pop() !== name) {
          return `the folder must end with the app name (${name}), e.g. ${name} or legacy/${name}`;
        }
        const d = dirOf(v);
        if (d === '') return folderProblem(name, undefined);
        try {
          parseDir(d, 'app');
        } catch (err) {
          return (err as Error).message.replace(/^app: /, '').replace('--dir=', 'folder ');
        }
        return folderProblem(name, d);
      },
    );
    a.dir = dirOf(answer) || '.';
  }
  if (given.port === undefined) {
    const used = usedServePorts(tree);
    const free = nextFreePort(used.map((u) => u.port));
    a.port = Number(
      await askValid(p, 'Dev-server port', String(free), (v) => {
        const n = /^\d+$/.test(v) ? Number(v) : NaN;
        const problem = portProblem(n);
        if (problem) return problem.replace(/^--port /, 'the port ');
        const owner = used.find((u) => u.port === n);
        return owner ? `port ${n} is used by ${owner.project}` : undefined;
      }),
    );
  }
  if (given.baseHref === undefined) {
    const answer = await askValid(
      p,
      'Base href of the release builds (none for none)',
      base.baseHref ? `/${name}/` : '/',
      (v) => {
        if (v === 'none') return undefined;
        try {
          checkBaseHref(v);
        } catch (err) {
          return (err as Error).message;
        }
        return undefined;
      },
    );
    a.baseHref = answer === 'none' ? null : answer;
  }
  if (base.type === 'ionic' && given.appId === undefined) {
    a.appId = await askValid(p, 'Capacitor appId', defaultAppId(name), (v) => {
      if (!APP_ID_RE.test(v)) return 'reverse-DNS, e.g. com.acme.portal';
      return v === base.appId ? `that is ${base.name}'s appId; pick another` : undefined;
    });
  }
  if (given.envs === undefined && base.envs.length > 1) {
    const answer = await askValid(
      p,
      `Environments to keep (${base.devEnv} is always kept)`,
      base.envs.join(','),
      (v) => {
        const unknown = list(v).filter((e) => !base.envs.includes(e));
        return unknown.length > 0
          ? `${base.name} has no ${unknown.join(', ')} (it has ${base.envs.join(', ')})`
          : undefined;
      },
    );
    a.envs = list(answer);
  }
  if (base.type !== 'flutter' && given.csp === undefined) {
    const answer = await askValid(p, 'CSP allowlist: keep or clear', 'keep', (v) =>
      v === 'keep' || v === 'clear' ? undefined : 'keep or clear',
    );
    a.csp = answer as 'keep' | 'clear';
  }
  if (given.tags === undefined) {
    a.tags = list(await p.ask('Tags (comma-separated)', base.tags.join(',')));
  }
  return a;
}

function summary(base: BaseApp, a: Answers): string[] {
  const envs = a.envs
    ? base.envs.filter((e) => e === base.devEnv || a.envs?.includes(e))
    : base.envs;
  return [
    '',
    `${a.name} from ${base.name} (${base.type}):`,
    `  folder      ${appRoot(a.name as string, a.dir === '.' ? undefined : a.dir ?? base.dir)}`,
    `  port        ${a.port ?? 'next free'}`,
    `  base href   ${a.baseHref ?? 'none'}`,
    ...(base.type === 'ionic' ? [`  appId       ${a.appId}`] : []),
    `  envs        ${envs.join(', ')} (every value emptied)`,
    ...(base.type !== 'flutter' ? [`  CSP         ${a.csp ?? 'keep'}`] : []),
    `  tags        ${(a.tags ?? base.tags).join(', ') || 'none'}`,
    '',
  ];
}
