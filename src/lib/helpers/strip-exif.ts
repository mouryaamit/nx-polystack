import * as fs from 'fs';
import * as path from 'path';

import { MetadataBlock, sniffImageFormat, stripMetadataLossless } from './image-metadata';

/**
 * The part of sharp used here. Typed locally: sharp 0.35's package types resolve to its ES module
 * declarations under TypeScript 4.9 (no call signature), and sharp 0.33-0.35 all fit this shape.
 */
interface SharpPipeline {
  rotate(): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  png(): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}
type Sharp = (input: Buffer, options: { failOn: 'none' }) => SharpPipeline;

/** sharp, loaded only for the images that must be re-encoded (an EXIF orientation other than 1). */
function loadSharp(): Sharp {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('sharp') as Sharp;
}

export interface StripExifOptions {
  /** Recursive root directory to scan for image files. */
  rootDir: string;
  /** JPEG and WebP output quality for images that are re-encoded. Default 90. */
  jpegQuality?: number;
  /** Optional logger; defaults to no-op. */
  log?: (msg: string) => void;
}

export interface StripFilesOptions {
  /** Change nothing; list the images that carry metadata (`found`). */
  check?: boolean;
  jpegQuality?: number;
  log?: (msg: string) => void;
}

export interface FoundImage {
  file: string;
  blocks: MetadataBlock[];
  /** Re-encoded (or, in check mode, would be) to keep an EXIF orientation other than 1. */
  reencode: boolean;
}

export interface StripExifResult {
  /** Image files looked at (.jpg, .jpeg, .png, .webp). */
  scanned: number;
  /** Files that had EXIF, XMP or IPTC and were written without it (none in check mode). */
  stripped: number;
  /** Files without those blocks, left byte-identical. */
  unchanged: number;
  /** Files that could not be read or written (logged, left as they were). */
  skipped: number;
}

export interface StripFilesResult extends StripExifResult {
  /** The images that had (or, in check mode, have) metadata. */
  found: FoundImage[];
}

/**
 * Whether a file's first bytes are text (an error page or a placeholder saved under an image
 * name): printable ASCII, tabs and line breaks only, after an optional UTF-8 BOM.
 */
function isText(buf: Buffer): boolean {
  const head = buf.subarray(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0, 512);
  return (
    head.length > 0 && head.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127))
  );
}

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Removes EXIF, XMP and IPTC from the given image files. The blocks are cut out without
 * re-encoding, so the image data and ICC profiles stay byte for byte. Only an image whose EXIF
 * orientation is not 1 is re-encoded through sharp, rotated first, so it still displays the same
 * way once the tag is gone. Files without those blocks are not written (bytes and mtime kept).
 */
export async function stripExifFiles(
  files: string[],
  opts: StripFilesOptions = {},
): Promise<StripFilesResult> {
  const log =
    opts.log ??
    (() => {
      /* no-op */
    });
  const quality = opts.jpegQuality ?? 90;
  const result: StripFilesResult = { scanned: 0, stripped: 0, unchanged: 0, skipped: 0, found: [] };
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    result.scanned++;
    try {
      const buf = fs.readFileSync(file);
      // The bytes decide the format: image files are often named after another one.
      const format = sniffImageFormat(buf) ?? ext;
      const scan = stripMetadataLossless(buf, format);
      if (!scan) {
        throw new Error(
          isText(buf)
            ? 'not an image (the file holds text)'
            : `not a readable ${ext.slice(1).toUpperCase()} file`,
        );
      }
      const named = ext === '.jpeg' ? '.jpg' : ext;
      const mismatch =
        format !== named ? `; ${format.slice(1).toUpperCase()} data in a ${ext} file` : '';
      if (scan.blocks.length === 0) {
        result.unchanged++;
        continue;
      }
      const reencode = scan.orientation !== 1;
      result.found.push({ file, blocks: scan.blocks, reencode });
      if (opts.check) continue;
      let out = scan.out;
      if (reencode) {
        let pipeline = loadSharp()(buf, { failOn: 'none' }).rotate();
        if (format === '.png') pipeline = pipeline.png();
        else if (format === '.webp') pipeline = pipeline.webp({ quality });
        else pipeline = pipeline.jpeg({ quality });
        out = await pipeline.toBuffer();
      }
      fs.writeFileSync(file, out);
      result.stripped++;
      log(
        `stripped: ${file} (${scan.blocks.join(', ')}${
          reencode ? '; re-encoded: orientation' : ''
        }${mismatch})`,
      );
    } catch (e) {
      result.skipped++;
      log(`skipped (error): ${file} — ${(e as Error).message}`);
    }
  }
  return result;
}

/** Removes EXIF, XMP and IPTC from the images under `rootDir` (see stripExifFiles). */
export async function stripExif(opts: StripExifOptions): Promise<StripExifResult> {
  if (!fs.existsSync(opts.rootDir)) {
    throw new Error(`stripExif: rootDir not found: ${opts.rootDir}`);
  }
  const files = [...walk(opts.rootDir)].filter((f) =>
    IMAGE_EXTS.has(path.extname(f).toLowerCase()),
  );
  const { scanned, stripped, unchanged, skipped } = await stripExifFiles(files, {
    jpegQuality: opts.jpegQuality,
    log: opts.log,
  });
  return { scanned, stripped, unchanged, skipped };
}

/** One line for the build log: `strip-exif: 1113 scanned, 222 stripped, 891 unchanged, 0 skipped`. */
export function stripExifSummary(r: StripExifResult): string {
  return `strip-exif: ${r.scanned} scanned, ${r.stripped} stripped, ${r.unchanged} unchanged, ${r.skipped} skipped`;
}

function* walk(dir: string): IterableIterator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
