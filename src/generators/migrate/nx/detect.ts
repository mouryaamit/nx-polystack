import { majorOf } from '../../../lib/utils/dependencies';
import type { Detection } from '../adapters/types';
import { sourceExists } from '../source';

import {
  discoverProjects,
  isSupportedKind,
  SourceProject,
  sourceNxVersion,
} from './workspace-source';

/** Nx majors of source workspaces (the plugin itself runs on Nx 17–22). */
export const SUPPORTED_NX_MAJORS = [15, 16, 17, 18, 19, 20, 21, 22];

export function detectNxWorkspace(sourceDir: string): Detection {
  if (!sourceExists(sourceDir, 'nx.json')) return { confidence: 0, reasons: ['no nx.json'] };
  const version = sourceNxVersion(sourceDir);
  const major = version ? majorOf(version) : undefined;
  const reasons = [`nx.json, Nx ${version ?? '(version not found in package.json)'}`];
  let confidence = 0.95;
  if (major === undefined || !SUPPORTED_NX_MAJORS.includes(major)) {
    confidence = 0.5;
    reasons.push(`Nx ${major ?? '?'} is outside the supported 15–22`);
  }
  let projects: SourceProject[];
  try {
    projects = discoverProjects(sourceDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { confidence: 0.3, reasons: [...reasons, message.replace(/^migrate: /, '')] };
  }
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  reasons.push(
    projects.length === 0
      ? 'no projects found'
      : `projects: ${[...counts]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([kind, n]) => `${n} ${kind}`)
          .join(', ')}`,
  );
  if (!projects.some((p) => isSupportedKind(p.kind))) {
    confidence = Math.min(confidence, 0.3);
    reasons.push('no project nx-polystack can migrate yet');
  }
  return { confidence, reasons };
}
