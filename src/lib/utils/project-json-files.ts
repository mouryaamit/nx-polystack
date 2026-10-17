import { readJson, Tree } from '@nx/devkit';

const SKIP = new Set(['node_modules', 'dist', 'tmp', 'coverage']);

/**
 * Every project.json in the tree (any depth; skips build output, node_modules and dot folders).
 * Walks the tree instead of getProjects(), which needs Nx's native file globbing.
 */
export function projectJsonFiles(tree: Tree, dir = ''): string[] {
  const out: string[] = [];
  for (const child of tree.children(dir)) {
    const rel = dir ? `${dir}/${child}` : child;
    if (tree.isFile(rel)) {
      if (child === 'project.json') out.push(rel);
    } else if (!SKIP.has(child) && !child.startsWith('.')) {
      out.push(...projectJsonFiles(tree, rel));
    }
  }
  return out;
}

export interface ReadProject {
  /** project.json name, else its folder name. */
  name: string;
  /** Folder of the project.json. */
  root: string;
  json: Record<string, unknown>;
}

/**
 * Every project of the tree with its name; throws naming the file when a project.json cannot be
 * read (JSON with comments is fine) and when two projects share a name.
 */
export function readProjects(tree: Tree): ReadProject[] {
  const seen = new Map<string, string>();
  return projectJsonFiles(tree).map((file) => {
    const root = file.slice(0, -'/project.json'.length) || '.';
    let json: Record<string, unknown>;
    try {
      json = readJson(tree, file);
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message.split('\n')[0]}`);
    }
    const name = typeof json['name'] === 'string' ? json['name'] : root.split('/').pop() ?? root;
    const other = seen.get(name);
    if (other !== undefined) {
      throw new Error(`two projects are named "${name}" (${other}, ${root}); set "name" in one`);
    }
    seen.set(name, root);
    return { name, root, json };
  });
}

/**
 * Like readProjects, but never throws: unreadable project.json files (templates, broken JSON)
 * are skipped and duplicate names are kept. For best-effort scans (ports, shared folders).
 */
export function scanProjects(tree: Tree): ReadProject[] {
  const out: ReadProject[] = [];
  for (const file of projectJsonFiles(tree)) {
    const root = file.slice(0, -'/project.json'.length) || '.';
    let json: Record<string, unknown>;
    try {
      json = readJson(tree, file);
    } catch {
      continue;
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) continue;
    const name = typeof json['name'] === 'string' ? json['name'] : root.split('/').pop() ?? root;
    out.push({ name, root, json });
  }
  return out;
}
