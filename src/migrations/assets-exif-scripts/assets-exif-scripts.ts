import { logger, Tree } from '@nx/devkit';

import { addExifScripts } from '../../lib/utils/exif-checks';

/**
 * v1.12.0 (NX-110): root npm scripts for the source images apps ship: assets:strip-exif (EXIF,
 * XMP and IPTC out, without re-encoding) and assets:check-exif (list them, exit 1). Only where
 * missing and no script runs pstack assets yet; hooks and CI are left to `pstack infra --exif`.
 */
export default async function assetsExifScripts(tree: Tree): Promise<void> {
  const added = addExifScripts(tree);
  if (added.length === 0) return;
  logger.info(
    `assets-exif-scripts: npm scripts ${added.join(
      ', ',
    )} added (pstack assets strip-exif --all). ` +
      'For a commit hook and a CI check: pstack infra --exif=fix (or check).',
  );
}
