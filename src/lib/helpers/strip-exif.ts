import * as fs from 'fs';
import * as path from 'path';

/**
 * The part of sharp used here. Typed locally: sharp 0.35's package types resolve to its ES module
 * declarations under TypeScript 4.9 (no call signature), and sharp 0.33-0.35 all fit this shape.
 */
interface SharpPipeline {
  rotate(): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  png(): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  metadata(): Promise<{ exif?: Buffer }>;
  toBuffer(): Promise<Buffer>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp') as (input: Buffer, options: { failOn: 'none' }) => SharpPipeline;

export interface StripExifOptions {
  /** Recursive root directory to scan for image files. */
  rootDir: string;
  /** JPEG and WebP output quality for images that are re-encoded. Default 90. */
  jpegQuality?: number;
  /** Optional logger; defaults to no-op. */
  log?: (msg: string) => void;
}

export interface StripExifResult {
  /** Image files looked at (.jpg, .jpeg, .png, .webp). */
  scanned: number;
  /** Files that had EXIF and were re-encoded without it. */
  stripped: number;
  /** Files without EXIF, left byte-identical. */
  unchanged: number;
  /** Files sharp could not read or write (logged, left as they were). */
  skipped: number;
}

const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Removes EXIF from the images under `rootDir`. Only images that carry EXIF are re-encoded (sharp
 * drops metadata unless `withMetadata()` is used); every other image is not written, so its bytes
 * and mtime stay as they were. A stripped image is rotated to its EXIF orientation first, so it
 * still displays the same way once the orientation tag is gone.
 */
export async function stripExif(opts: StripExifOptions): Promise<StripExifResult> {
  if (!fs.existsSync(opts.rootDir)) {
    throw new Error(`stripExif: rootDir not found: ${opts.rootDir}`);
  }
  const log =
    opts.log ??
    (() => {
      /* no-op */
    });
  const quality = opts.jpegQuality ?? 90;
  const result: StripExifResult = { scanned: 0, stripped: 0, unchanged: 0, skipped: 0 };

  for (const file of walk(opts.rootDir)) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) continue;
    result.scanned++;
    try {
      const buf = fs.readFileSync(file);
      const meta = await sharp(buf, { failOn: 'none' }).metadata();
      if (!meta.exif || meta.exif.length === 0) {
        result.unchanged++;
        continue;
      }
      let pipeline = sharp(buf, { failOn: 'none' }).rotate();
      if (ext === '.png') pipeline = pipeline.png();
      else if (ext === '.webp') pipeline = pipeline.webp({ quality });
      else pipeline = pipeline.jpeg({ quality });
      const out = await pipeline.toBuffer();
      fs.writeFileSync(file, out);
      result.stripped++;
      log(`stripped: ${file}`);
    } catch (e) {
      result.skipped++;
      log(`skipped (error): ${file} — ${(e as Error).message}`);
    }
  }
  return result;
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
