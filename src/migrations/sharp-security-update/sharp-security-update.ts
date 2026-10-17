import { logger, readJson, Tree, writeJson } from '@nx/devkit';

/** sharp before 0.35.5 bundles libvips, libheif and librsvg versions with known vulnerabilities. */
export const SHARP_FIXED = '^0.35.5';

/** A caret or tilde range, or an exact version, below 0.35.5; other specs are left alone. */
export function needsSharpUpdate(spec: unknown): boolean {
  if (typeof spec !== 'string') return false;
  const m = /^[\^~]?0\.(\d+)\.(\d+)$/.exec(spec.trim());
  if (!m) return false;
  const [minor, patch] = [Number(m[1]), Number(m[2])];
  return minor < 35 || (minor === 35 && patch < 5);
}

/**
 * v0.39.3: sharp (used by the release build to strip image metadata) moves to ^0.35.5, the first
 * version without the libvips, libheif and librsvg vulnerabilities. Run npm install afterwards.
 */
export default async function sharpSecurityUpdate(tree: Tree): Promise<void> {
  if (!tree.exists('package.json')) return;
  const pkg = readJson(tree, 'package.json');
  let changed: string | undefined;
  for (const field of ['dependencies', 'devDependencies']) {
    const spec = pkg[field]?.sharp;
    if (needsSharpUpdate(spec)) {
      pkg[field].sharp = SHARP_FIXED;
      changed = `${field}: sharp ${spec} → ${SHARP_FIXED}`;
    }
  }
  if (!changed) return;
  writeJson(tree, 'package.json', pkg);
  logger.info(`sharp-security-update: ${changed}. Run npm install.`);
}
