import { Tree } from '@nx/devkit';

import { keepJsonLayout, loadJsonc } from './json-layout';

/** How generated Angular code is organised: NgModules, or standalone components. */
export type AngularStyle = 'module' | 'standalone';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** nx.json `pstack.angular.style`; "module" when absent or unreadable. */
export function workspaceAngularStyle(tree: Tree): AngularStyle {
  if (!tree.exists('nx.json')) return 'module';
  try {
    const json = JSON.parse(tree.read('nx.json', 'utf8') ?? '{}') as Json;
    const pstack = isObject(json['pstack']) ? json['pstack'] : {};
    const angular = isObject(pstack['angular']) ? pstack['angular'] : {};
    return angular['style'] === 'standalone' ? 'standalone' : 'module';
  } catch {
    return 'module';
  }
}

/** Writes nx.json `pstack.angular.style`, keeping the rest of the file's layout. */
export function saveWorkspaceAngularStyle(tree: Tree, style: AngularStyle): void {
  if (!tree.exists('nx.json')) return;
  const before = tree.read('nx.json', 'utf8') ?? '';
  const json = JSON.parse(before) as Json;
  const pstack = isObject(json['pstack']) ? json['pstack'] : {};
  const angular = isObject(pstack['angular']) ? pstack['angular'] : {};
  json['pstack'] = { ...pstack, angular: { ...angular, style: style } };
  const after = JSON.stringify(json, null, 2);
  const jsonc = loadJsonc(tree.root);
  tree.write('nx.json', (jsonc && keepJsonLayout(jsonc, before, after)) || `${after}\n`);
}

/**
 * The style for a new app or library: `--standalone` or `--module` when given (not both), else
 * the workspace default (nx.json `pstack.angular.style`), else NgModules.
 */
export function resolveAngularStyle(
  tree: Tree,
  flags: { standalone?: boolean; module?: boolean },
  what: string,
): AngularStyle {
  if (flags.standalone && flags.module) {
    throw new Error(`${what}: pass --standalone or --module, not both.`);
  }
  if (flags.standalone) return 'standalone';
  if (flags.module) return 'module';
  return workspaceAngularStyle(tree);
}
