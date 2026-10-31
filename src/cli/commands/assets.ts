import * as path from 'path';

import { imageFiles, ImageSource, selectImageSources } from '../../lib/assets/source-images';
import {
  FoundImage,
  IMAGE_EXTS,
  stripExifFiles,
  stripExifSummary,
} from '../../lib/helpers/strip-exif';
import { fsTree } from '../../lib/utils/nx-tree';
import { flagBoolean, flagString } from '../args';
import { CliError, CommandContext } from '../types';

import { requireWorkspace } from './app';

const USAGE =
  'pstack assets strip-exif [--app=a,b | --all] [--dir=p1,p2] [--check | --dry-run] [files…]';

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The selector to print in hints (`--app=a,b`, `--dir=…`, or nothing for --all). */
function selector(apps: string[], dirs: string[], all: boolean): string {
  const parts = [
    ...(apps.length ? [`--app=${apps.join(',')}`] : []),
    ...(all && (apps.length || dirs.length) ? ['--all'] : []),
    ...(dirs.length ? [`--dir=${dirs.join(',')}`] : []),
  ];
  return parts.join(' ');
}

function describeFound(f: FoundImage, root: string): string {
  const rel = path.relative(root, f.file).split(path.sep).join('/');
  return `  ${rel} (${f.blocks.join(', ')})${
    f.reencode ? ' — re-encoded when stripped (orientation)' : ''
  }`;
}

function folders(sources: ImageSource[]): string {
  const seen = [...new Set(sources.map((s) => s.path))];
  return seen.length ? seen.join(', ') : '(none)';
}

/**
 * `pstack assets strip-exif`: EXIF, XMP and IPTC out of the source images an app ships (its asset
 * folders), without re-encoding them; `--check` lists the images that still carry them.
 */
export async function runAssets(ctx: CommandContext): Promise<number> {
  const [sub, ...files] = ctx.positionals;
  if (sub !== 'strip-exif') {
    throw new CliError(`usage: ${USAGE}`);
  }
  const root = requireWorkspace(ctx.cwd, 'assets strip-exif');
  const check = flagBoolean(ctx.flags, 'check');
  const listOnly = check || ctx.dryRun;
  const apps = list(flagString(ctx.flags, 'app'));
  const dirs = list(flagString(ctx.flags, 'dir'));
  let all = flagBoolean(ctx.flags, 'all');

  let paths: string[];
  if (files.length > 0) {
    if (apps.length || dirs.length || all) {
      throw new CliError('pstack assets strip-exif: give files, or --app/--all/--dir, not both.');
    }
    paths = files.map((f) => path.resolve(ctx.cwd, f));
  } else {
    // No selector: every app's asset folders and the assets libraries.
    if (!apps.length && !dirs.length) all = true;
    const tree = fsTree(root);
    let sources: ImageSource[];
    try {
      sources = selectImageSources(tree, { apps, all, dirs });
    } catch (err) {
      throw new CliError(`pstack assets strip-exif: ${(err as Error).message}.`);
    }
    // Only what exists and can hold images (no favicon.ico entries).
    const shown = sources.filter(
      (s) =>
        tree.exists(s.path) &&
        (!tree.isFile(s.path) || IMAGE_EXTS.has(path.extname(s.path).toLowerCase())),
    );
    console.log(`Folders: ${folders(shown)}`);
    paths = imageFiles(tree, sources).map((f) => path.join(root, f));
  }

  const logs: string[] = [];
  const result = await stripExifFiles(paths, {
    check: listOnly,
    log: (m) => logs.push(m.replace(root + path.sep, '')),
  });
  for (const l of logs) console.log(l);

  if (listOnly) {
    for (const f of result.found) console.log(describeFound(f, root));
    const n = result.found.length;
    if (n === 0) {
      console.log(`No EXIF, XMP or IPTC in ${result.scanned} image(s).`);
    } else {
      const sel = files.length ? files.join(' ') : selector(apps, dirs, all);
      console.log(
        `${n} image(s) with EXIF/XMP/IPTC; run "pstack assets strip-exif${
          sel ? ` ${sel}` : ''
        }" to remove it.`,
      );
    }
    if (result.skipped > 0) console.log(`${result.skipped} file(s) could not be read.`);
    return check && (n > 0 || result.skipped > 0) ? 1 : 0;
  }
  console.log(`${stripExifSummary(result)} (source)`);
  return result.skipped > 0 ? 1 : 0;
}
