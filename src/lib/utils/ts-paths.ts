import { Tree, updateJson } from '@nx/devkit';

export function addTsPath(tree: Tree, alias: string, target: string): void {
  updateJson(tree, 'tsconfig.base.json', (json: Record<string, unknown>) => {
    const opts = (json['compilerOptions'] ?? {}) as Record<string, unknown>;
    const paths = (opts['paths'] ?? {}) as Record<string, string[]>;
    if (paths[alias]) {
      throw new Error(`addTsPath: alias "${alias}" is already mapped`);
    }
    paths[alias] = [target];
    opts['paths'] = paths;
    json['compilerOptions'] = opts;
    return json;
  });
}

export function removeTsPath(tree: Tree, alias: string): void {
  updateJson(tree, 'tsconfig.base.json', (json: Record<string, unknown>) => {
    const opts = json['compilerOptions'] as Record<string, unknown> | undefined;
    if (opts) {
      const paths = opts['paths'] as Record<string, string[]> | undefined;
      if (paths) delete paths[alias];
    }
    return json;
  });
}
