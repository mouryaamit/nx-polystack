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
  toBuffer(): Promise<Buffer>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp') as (input: Buffer, options: { failOn: 'none' }) => SharpPipeline;

export interface StripExifOptions {
  /** Recursive root directory to scan for image files. */
  rootDir: string;
  /** JPEG output quality. Default 90. */
  jpegQuality?: number;
  /** Optional logger; defaults to no-op. */
  log?: (msg: string) => void;
}

const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export async function stripExif(opts: StripExifOptions): Promise<void> {
  if (!fs.existsSync(opts.rootDir)) {
    throw new Error(`stripExif: rootDir not found: ${opts.rootDir}`);
  }
  const log =
    opts.log ??
    (() => {
      /* no-op */
    });
  const quality = opts.jpegQuality ?? 90;

  for (const file of walk(opts.rootDir)) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) continue;
    try {
      const buf = fs.readFileSync(file);
      let pipeline = sharp(buf, { failOn: 'none' }).rotate();
      if (ext === '.jpg' || ext === '.jpeg') pipeline = pipeline.jpeg({ quality });
      else if (ext === '.png') pipeline = pipeline.png();
      else if (ext === '.webp') pipeline = pipeline.webp({ quality });
      // sharp drops EXIF/IPTC/XMP by default when re-encoding; no withMetadata() needed
      const out = await pipeline.toBuffer();
      fs.writeFileSync(file, out);
      log(`stripped: ${file}`);
    } catch (e) {
      log(`skipped (error): ${file} — ${(e as Error).message}`);
    }
  }
}

function* walk(dir: string): IterableIterator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}
