import { writeJson } from '@nx/devkit';

import {
  baseHrefTarget,
  checkBaseHref,
  isDevConfiguration,
  setBaseHref,
} from '../../lib/utils/base-href';
import { readProjects } from '../../lib/utils/project-json-files';
import { flagString } from '../args';
import { runInTree } from '../run-tree';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

/** pstack release --app=<project>: shows or sets the base href of its release configurations. */
export async function runRelease(ctx: CommandContext): Promise<number> {
  for (const f of ['app', 'configuration', 'baseHref']) {
    if (ctx.flags[f] === true) {
      throw new CliError(`--${f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a value.`);
    }
  }
  const app = flagString(ctx.flags, 'app');
  if (!app) throw new CliError('--app=<project> is required.');
  const only = flagString(ctx.flags, 'configuration');
  const raw = flagString(ctx.flags, 'baseHref');
  let href: string | undefined;
  if (raw !== undefined && raw !== 'none') {
    try {
      href = checkBaseHref(raw);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
  }
  const root = requireWorkspace(ctx.cwd, 'release');

  const lines: string[] = [];
  const notes: string[] = [];
  await runInTree(root, { ...ctx, quietWhenUnchanged: true }, (tree) => {
    let projects;
    try {
      projects = readProjects(tree);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    const found = projects.find((p) => p.name === app);
    if (!found) throw new CliError(`No project named "${app}".`);
    const t = baseHrefTarget(found.json);
    if (!t) {
      throw new CliError(
        `"${app}" has no release target (or Flutter build-web); run "pstack update" first.`,
      );
    }
    const configurations = t.target.configurations ?? {};
    if (only !== undefined && !configurations[only]) {
      throw new CliError(`The ${t.name} target of "${app}" has no configuration "${only}".`);
    }
    if (raw !== undefined) {
      const chosen =
        only !== undefined
          ? [only]
          : Object.keys(configurations).filter((c) => !isDevConfiguration(t.target, c));
      if (chosen.length === 0) throw new CliError(`"${app}" has no non-DEV configuration.`);
      const changed = chosen.filter((c) => configurations[c]?.['baseHref'] !== href);
      if (changed.length > 0) {
        setBaseHref(t.target, changed, href);
        writeJson(tree, `${found.root}/project.json`, found.json);
        notes.push(`${href === undefined ? 'Removed from' : 'Set on'} ${changed.join(', ')}.`);
      } else {
        notes.push(`Already ${href === undefined ? 'unset' : href} on ${chosen.join(', ')}.`);
      }
    }
    lines.push(`Base href of ${app} (${t.name}):`);
    for (const [name, conf] of Object.entries(t.target.configurations ?? {})) {
      const value = conf?.['baseHref'] ?? t.target.options?.['baseHref'];
      lines.push(`  ${name.padEnd(12)}${typeof value === 'string' ? value : '— (none)'}`);
    }
  });
  for (const l of lines) console.log(l);
  for (const n of notes) console.log(`Note: ${n}`);
  return 0;
}
