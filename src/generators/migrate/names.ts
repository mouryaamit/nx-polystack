import { names } from '@nx/devkit';

export {
  MAX_DIR_DEPTH,
  NAME_RE,
  appRoot,
  assertDirOutsideProjects,
  parseDir,
  upTo,
} from '../../lib/utils/app-dir';

/** "LegacyPortal" / "field_notes" / "My App" → "legacy-portal" / "field-notes" / "my-app". */
export function kebabName(raw: string): string {
  return names(raw)
    .fileName.toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-0-9]+|-+$/g, '');
}
