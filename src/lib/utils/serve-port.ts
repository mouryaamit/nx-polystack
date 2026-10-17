import { Tree } from '@nx/devkit';

import { scanProjects } from './project-json-files';

/** Port Angular's dev-server and the flutter-build serve use when none is set. */
export const DEFAULT_SERVE_PORT = 4200;

type Target = { executor?: string; options?: Record<string, unknown> };

/** Angular/Ionic dev-server (Angular CLI or @nx/angular builder) or a Flutter serve target. */
export function isServeTarget(target: Target | undefined): boolean {
  if (!target || typeof target.executor !== 'string') return false;
  if (
    /^(@angular-devkit\/build-angular|@angular\/build|@nx\/angular):dev-server$/.test(
      target.executor,
    )
  ) {
    return true;
  }
  return (
    target.executor === '@mouryaamit/nx-polystack:flutter-build' &&
    target.options?.['serve'] === true
  );
}

/** The serve target of a project.json (the `serve` target first, else any serve-like target). */
export function serveTargetOf(json: Record<string, unknown>): Target | undefined {
  const targets = (json['targets'] ?? {}) as Record<string, Target>;
  if (isServeTarget(targets['serve'])) return targets['serve'];
  return Object.values(targets).find((t) => isServeTarget(t));
}

/** The port a serve target listens on (4200 when unset or not a number). */
export function portOf(target: Target): number {
  return explicitPort(target) ?? DEFAULT_SERVE_PORT;
}

/** The port set on a serve target (a number or a numeric string), else undefined. */
export function explicitPort(target: Target): number | undefined {
  const p = target.options?.['port'];
  const n = typeof p === 'string' && /^\d+$/.test(p.trim()) ? Number(p) : p;
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
}

export interface UsedPort {
  project: string;
  port: number;
  /** false when the port is the default because none is set. */
  explicit: boolean;
}

/** Every app serve port of the workspace. */
export function usedServePorts(tree: Tree): UsedPort[] {
  const out: UsedPort[] = [];
  for (const p of scanProjects(tree)) {
    const serve = serveTargetOf(p.json);
    if (!serve) continue;
    out.push({
      project: p.name,
      port: portOf(serve),
      explicit: explicitPort(serve) !== undefined,
    });
  }
  return out;
}

/** The lowest port from `start` not in `used`. */
export function nextFreePort(used: Iterable<number>, start = DEFAULT_SERVE_PORT): number {
  const taken = new Set(used);
  let port = start;
  while (taken.has(port)) port++;
  if (port > 65535) throw new Error('no free dev-server port left');
  return port;
}

/** Why `port` cannot be an app's dev-server port, or null. */
export function portProblem(port: unknown): string | null {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return `--port must be a whole number from 1024 to 65535 (got ${String(port)})`;
  }
  return null;
}
