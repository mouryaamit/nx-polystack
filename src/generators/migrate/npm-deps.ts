import * as path from 'path';

/** Pure helpers for the source package.json (no tree, no fs). */

export interface SpecContext {
  /** Absolute source repo root (where package.json is). */
  sourceDir: string;
  /** Absolute folder that was copied to apps/<name> (the repo root or the project root). */
  copiedDir: string;
  /** apps/<name>; '' when the copied files keep their source paths. */
  projectRoot: string;
}

export type SpecKind =
  | { kind: 'registry' }
  | { kind: 'rebased'; spec: string }
  | { kind: 'outside'; target: string };

const LOCAL_PROTOCOL = /^(file|link|portal):(.*)$/;

/** The local path a dependency spec points at, relative to package.json; undefined for others. */
export function localPath(spec: string): string | undefined {
  const m = LOCAL_PROTOCOL.exec(spec.trim());
  if (m) return m[2] || '.';
  if (/^(\.\.?(\/|$)|\/|~\/)/.test(spec.trim())) return spec.trim();
  return undefined;
}

/**
 * file:, link:, portal: and relative-path specs: inside the copied folder they are rebased to
 * `file:apps/<name>/…` (the root package.json is at the workspace root); elsewhere they are
 * reported as outside. Registry, tag, git and URL specs are left alone.
 */
export function classifyDependencySpec(spec: string, ctx: SpecContext): SpecKind {
  const local = localPath(spec);
  if (local === undefined || local.startsWith('~/')) {
    return local === undefined ? { kind: 'registry' } : { kind: 'outside', target: local };
  }
  const target = path.resolve(ctx.sourceDir, local);
  const rel = path.relative(ctx.copiedDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { kind: 'outside', target };
  const posix = rel.split(path.sep).join('/');
  if (ctx.projectRoot === '') return { kind: 'rebased', spec: `file:${posix || '.'}` };
  return {
    kind: 'rebased',
    spec: `file:${posix ? `${ctx.projectRoot}/${posix}` : ctx.projectRoot}`,
  };
}

/** .browserslistrc content for a package.json `browserslist` value (array, string or per-env). */
export function browserslistFile(value: unknown): string | undefined {
  const lines = (v: unknown): string[] | undefined =>
    typeof v === 'string'
      ? [v]
      : Array.isArray(v) && v.every((q) => typeof q === 'string')
      ? (v as string[])
      : undefined;
  const flat = lines(value);
  if (flat) return flat.join('\n') + '\n';
  if (value && typeof value === 'object') {
    const sections: string[] = [];
    for (const [env, queries] of Object.entries(value as Record<string, unknown>)) {
      const l = lines(queries);
      if (!l) return undefined;
      sections.push(`[${env}]\n${l.join('\n')}`);
    }
    return sections.length ? sections.join('\n\n') + '\n' : undefined;
  }
  return undefined;
}
