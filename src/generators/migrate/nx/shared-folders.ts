import * as fs from 'fs';
import * as path from 'path';

import { importSpecifiers } from './selection';
import { isObject, Json } from './workspace-source';

/**
 * Folders an Nx source's projects use that are not Nx projects themselves: an assets or styles
 * folder under libs/, a root environments/ folder that fileReplacements swap in, a tools/ folder
 * with scripts the code or the npm scripts run. They are copied to the same path.
 */

export interface SharedFolder {
  /** Source-relative folder, POSIX. */
  path: string;
  /** Why it is copied (e.g. "assets of portal", "imported by apps/portal/src/main.ts"). */
  reasons: string[];
}

/** Option keys whose values (strings, array entries, `{ input }` entries) are paths. */
const PATH_OPTIONS = new Set([
  'main',
  'index',
  'tsConfig',
  'polyfills',
  'styles',
  'scripts',
  'assets',
  'includePaths',
  'replace',
  'with',
  'proxyConfig',
  'ngswConfigPath',
  'karmaConfig',
  'jestConfig',
]);

/** Never copied as shared folders. */
const NOT_SHARED = new Set([
  'node_modules',
  'dist',
  'out-tsc',
  'www',
  'build',
  '.cache',
  'tmp',
  'coverage',
  '.git',
  '.angular',
  '.nx',
  '.vscode',
  '.idea',
  '.github',
  '.husky',
]);

const CODE_FILE = /\.(ts|tsx|mts|js|mjs|cjs)$/;
const STYLE_FILE = /\.(scss|sass|css|less)$/;
/** `@import`/`@use`/`@forward` of a relative path in a stylesheet. */
const STYLE_IMPORT = /@(?:import|use|forward)\s+(?:url\()?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/** npm lifecycle scripts: they run on install/publish, so they are never carried over. */
export const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'preuninstall',
  'uninstall',
  'postuninstall',
]);

export interface SharedFolderInput {
  sourceDir: string;
  /** Roots of every source project (copied or not), POSIX, source-relative. */
  projectRoots: string[];
  /** Roots of the projects being copied; references into other projects are reported. */
  selectedRoots?: string[];
}

export interface RootFile {
  /** Source-relative file at the repo root (e.g. "decorate-angular-cli.js"). */
  path: string;
  reasons: string[];
}

/** Collects references and turns them into shared folders. */
export class SharedFolderFinder {
  private readonly found = new Map<string, Set<string>>();
  private readonly files = new Map<string, Set<string>>();
  private readonly unselected = new Map<string, Set<string>>();
  /** A baseUrl-style import (`environments/x`) was found. */
  usedBaseUrl = false;

  constructor(private readonly input: SharedFolderInput) {}

  /** Paths in a project's target options. */
  addProjectConfig(projectName: string, config: Json): void {
    const visit = (key: string, value: unknown) => {
      if (PATH_OPTIONS.has(key)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (typeof v === 'string') this.add(v, `${key} of ${projectName}`);
          else if (isObject(v) && typeof v['input'] === 'string') {
            this.add(v['input'] as string, `${key} of ${projectName}`);
          }
        }
      }
      if (Array.isArray(value)) value.forEach((v) => visit('', v));
      else if (isObject(value)) for (const [k, v] of Object.entries(value)) visit(k, v);
    };
    visit('', config['targets']);
  }

  /** tsconfig.base.json typeRoots, include and files of the source. */
  addTsconfig(tsconfig: Json | undefined): void {
    const co = isObject(tsconfig?.['compilerOptions'])
      ? (tsconfig?.['compilerOptions'] as Json)
      : {};
    const lists: [string, unknown][] = [
      ['typeRoots', co['typeRoots']],
      ['tsconfig include', tsconfig?.['include']],
      ['tsconfig files', tsconfig?.['files']],
    ];
    for (const [why, list] of lists) {
      if (!Array.isArray(list)) continue;
      for (const v of list) if (typeof v === 'string') this.add(v, why);
    }
  }

  /** Files the root npm scripts run (`node tools/scripts/build.js …`). */
  addScripts(scripts: Record<string, string> | undefined): void {
    for (const [name, command] of Object.entries(scripts ?? {})) {
      if (typeof command !== 'string' || LIFECYCLE_SCRIPTS.has(name)) continue;
      const paths = new Set<string>();
      for (const m of command.matchAll(/(?:^|[\s=])(\.{0,2}\/?[\w@.-]+\/[\w@./-]+)/g)) {
        paths.add(m[1]);
      }
      for (const m of command.matchAll(/\b(?:node|ts-node|sh|bash)\s+(['"]?)([\w@./-]+)\1/g)) {
        paths.add(m[2]);
      }
      for (const p of paths) {
        if (/\.(js|mjs|cjs|ts|sh|json)$/.test(p)) this.add(p, `npm script "${name}"`);
      }
    }
  }

  /**
   * Imports in a copied code file (`file` is source-relative): relative imports that leave every
   * project, and baseUrl-style imports (`environments/x/y`) of a root folder when `baseUrl` is ".".
   */
  addCode(file: string, text: string, baseUrlRoot: boolean): void {
    if (STYLE_FILE.test(file)) {
      for (const m of text.matchAll(STYLE_IMPORT)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
        this.add(target, `imported by ${file}`);
      }
      return;
    }
    if (!CODE_FILE.test(file)) return;
    for (const spec of importSpecifiers(text)) {
      if (spec.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
        this.add(target, `imported by ${file}`);
      } else if (baseUrlRoot && !spec.startsWith('@') && spec.includes('/')) {
        const first = spec.split('/')[0];
        if (this.isSourceDir(first)) {
          this.usedBaseUrl = true;
          this.add(spec, `imported by ${file}`);
        }
      }
    }
  }

  /** Files at the repo root that options or scripts use (copied unless secret or existing). */
  rootFiles(): RootFile[] {
    return [...this.files]
      .map(([p, reasons]) => ({ path: p, reasons: [...reasons].sort() }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** Projects that were not selected but that copied code or options reach into: root → why. */
  unselectedReferences(): [string, string[]][] {
    return [...this.unselected]
      .map(([root, reasons]): [string, string[]] => [root, [...reasons].sort()])
      .sort(([a], [b]) => (a < b ? -1 : 1));
  }

  /** The folders found, sorted, without those inside or around a project. */
  folders(): SharedFolder[] {
    return [...this.found]
      .map(([p, reasons]) => ({ path: p, reasons: [...reasons].sort() }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  private isSourceDir(rel: string): boolean {
    try {
      return fs.statSync(path.join(this.input.sourceDir, ...rel.split('/'))).isDirectory();
    } catch {
      return false;
    }
  }

  private isSourceFile(rel: string): boolean {
    try {
      return fs.statSync(path.join(this.input.sourceDir, ...rel.split('/'))).isFile();
    } catch {
      return false;
    }
  }

  private add(raw: string, reason: string): void {
    const unit = this.unitOf(raw, reason);
    if (!unit) return;
    const set = this.found.get(unit) ?? new Set<string>();
    set.add(reason);
    this.found.set(unit, set);
  }

  /** The folder a path belongs to: `<container>/<name>` under a projects folder, else `<top>`. */
  private unitOf(raw: string, reason: string): string | undefined {
    if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return undefined;
    let p = path.posix.normalize(raw.replace(/\\/g, '/').replace(/^!/, ''));
    p = p.split('*')[0].replace(/\/$/, '');
    if (!p || p === '.' || p.startsWith('..')) return undefined;
    const parts = p.split('/');
    if (NOT_SHARED.has(parts[0])) return undefined;
    if (parts.length === 1 && this.isSourceFile(p)) {
      // A file at the repo root (a script, a proxy config): copied on its own.
      const set = this.files.get(p) ?? new Set<string>();
      set.add(reason);
      this.files.set(p, set);
      return undefined;
    }
    const roots = this.input.projectRoots.filter((r) => r !== '');
    // Inside a project: the project brings it (when it is copied).
    const owner = roots
      .filter((r) => p === r || p.startsWith(`${r}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (owner) {
      if (this.input.selectedRoots && !this.input.selectedRoots.includes(owner)) {
        const set = this.unselected.get(owner) ?? new Set<string>();
        set.add(reason);
        this.unselected.set(owner, set);
      }
      return undefined;
    }
    const containers = new Set(roots.map((r) => r.split('/')[0]));
    const unit =
      containers.has(parts[0]) && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
    // Around a project (e.g. "apps" itself): not a shared folder.
    if (roots.some((r) => r === unit || r.startsWith(`${unit}/`))) return undefined;
    return this.isSourceDir(unit) ? unit : undefined;
  }
}
