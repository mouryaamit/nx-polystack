import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import {
  sniffImageFormat,
  stripMetadataLossless,
  tiffOrientation,
} from '../../src/lib/helpers/image-metadata';
import { stripExifFiles } from '../../src/lib/helpers/strip-exif';

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const sharp = require('sharp') as any;

const base = (w = 4, h = 4) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } });

/** A JPEG segment (marker + length + data). */
const segment = (marker: number, data: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
};
const XMP_SEGMENT = segment(
  0xe1,
  Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><gps>1,2</gps></x:xmpmeta>', 'latin1'),
);
const IPTC_SEGMENT = segment(
  0xed,
  Buffer.concat([
    Buffer.from('Photoshop 3.0\0', 'latin1'),
    Buffer.from('8BIM\x04\x04\0\0\0\0\0\x08', 'latin1'),
    Buffer.from([0x1c, 0x02, 0x50, 0x00, 0x03, 0x41, 0x42, 0x43]), // By-line "ABC"
  ]),
);
/** Inserts segments right after SOI. */
const withSegments = (jpeg: Buffer, ...segs: Buffer[]) =>
  Buffer.concat([jpeg.subarray(0, 2), ...segs, jpeg.subarray(2)]);

/** A PNG chunk with its CRC. */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : 0);
  return Buffer.concat([len, td, crc]);
}
/** Inserts chunks after IHDR. */
const withChunks = (png: Buffer, ...chunks: Buffer[]) => {
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd)]);
};

describe('lossless metadata removal (NX-110)', () => {
  it('JPEG: cuts EXIF, XMP and IPTC; ICC profile and image data stay byte for byte', async () => {
    const icc = await base().withIccProfile('srgb').jpeg().toBuffer();
    // An APP1 Exif segment as cameras write it (TIFF, one IFD0 entry: Make).
    const tiff = Buffer.from(
      'II*\0\x08\0\0\0\x01\0\x0f\x01\x02\0\x04\0\0\0Cam\0\0\0\0\0',
      'latin1',
    );
    const exifSegment = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
    const input = withSegments(icc, exifSegment, XMP_SEGMENT, IPTC_SEGMENT);
    const scan = stripMetadataLossless(input, '.jpg');
    expect(scan?.blocks).toEqual(['EXIF', 'XMP', 'IPTC']);
    expect(scan?.orientation).toBe(1);
    // Same as the file made without EXIF: only the blocks went.
    expect(scan?.out.equals(icc)).toBe(true);
    const meta = await sharp(scan?.out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.icc).toBeDefined();
  });

  it('JPEG: reads the orientation; a file without blocks comes back as it was', async () => {
    const rotated = await base(8, 6).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect(stripMetadataLossless(rotated, '.jpeg')?.orientation).toBe(6);
    const plain = await base().jpeg().toBuffer();
    const scan = stripMetadataLossless(plain, '.jpg');
    expect(scan?.blocks).toEqual([]);
    expect(scan?.out).toBe(plain);
  });

  it('PNG: eXIf, XMP text and ImageMagick raw profiles (zTXt too) go, other chunks stay', async () => {
    const plain = await base().png().toBuffer();
    const exif = await base()
      .withExif({ IFD0: { Make: 'Cam' } })
      .png()
      .toBuffer();
    const exifChunk = stripMetadataLossless(exif, '.png');
    expect(exifChunk?.blocks).toEqual(['EXIF']);

    const keepText = chunk('tEXt', Buffer.from('Comment\0kept', 'latin1'));
    const xmp = chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>', 'latin1'));
    const rawIptc = chunk(
      'zTXt',
      Buffer.concat([
        Buffer.from('Raw profile type iptc\0\0', 'latin1'),
        zlib.deflateSync(Buffer.from('\niptc\n       4\n1c025000\n')),
      ]),
    );
    const input = withChunks(plain, keepText, xmp, rawIptc);
    const scan = stripMetadataLossless(input, '.png');
    expect(scan?.blocks).toEqual(['XMP', 'IPTC']);
    expect(scan?.out.equals(withChunks(plain, keepText))).toBe(true);
  });

  it('WebP: EXIF and XMP chunks go, the VP8X flags and RIFF size are fixed', async () => {
    const webp = await base()
      .withExif({ IFD0: { Make: 'Cam' } })
      .webp({ quality: 80 })
      .toBuffer();
    const scan = stripMetadataLossless(webp, '.webp');
    expect(scan?.blocks).toEqual(['EXIF']);
    const out = scan!.out;
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    const vp8x = out.indexOf('VP8X');
    expect(out[vp8x + 8] & 0x08).toBe(0);
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.width).toBe(4);
  });

  it('reads orientation from big- and little-endian TIFF and the Exif prefix', () => {
    const tiff = (le: boolean, value: number) => {
      const b = Buffer.alloc(26);
      b.write(le ? 'II' : 'MM', 0, 'latin1');
      const w16 = (v: number, o: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
      const w32 = (v: number, o: number) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
      w16(42, 2);
      w32(8, 4);
      w16(1, 8);
      w16(0x0112, 10);
      w16(3, 12);
      w32(1, 14);
      w16(value, 18);
      return b;
    };
    expect(tiffOrientation(tiff(true, 3))).toBe(3);
    expect(tiffOrientation(tiff(false, 8))).toBe(8);
    expect(tiffOrientation(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(true, 6)]))).toBe(
      6,
    );
    expect(tiffOrientation(Buffer.from('nonsense'))).toBe(1);
  });

  it('returns null for bytes that are not the named kind', () => {
    expect(stripMetadataLossless(Buffer.from('not an image'), '.png')).toBeNull();
    expect(stripMetadataLossless(Buffer.from('not an image'), '.jpg')).toBeNull();
    expect(stripMetadataLossless(Buffer.from('RIFF0000WAVE'), '.webp')).toBeNull();
  });
});

describe('stripExifFiles (NX-110)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-files-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, b: Buffer) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, b);
    return f;
  };

  it('check mode lists the images with metadata and writes nothing', async () => {
    const withXmp = write('a.jpg', withSegments(await base().jpeg().toBuffer(), XMP_SEGMENT));
    const plain = write('b.png', await base().png().toBuffer());
    const rotated = write(
      'c.jpg',
      await base(8, 6).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    );
    const before = [withXmp, plain, rotated].map((f) => fs.readFileSync(f));
    const r = await stripExifFiles([withXmp, plain, rotated, path.join(dir, 'x.txt')], {
      check: true,
    });
    expect(r).toEqual({
      scanned: 3,
      stripped: 0,
      unchanged: 1,
      skipped: 0,
      found: [
        { file: withXmp, blocks: ['XMP'], reencode: false },
        { file: rotated, blocks: ['EXIF'], reencode: true },
      ],
    });
    [withXmp, plain, rotated].forEach((f, i) =>
      expect(fs.readFileSync(f).equals(before[i])).toBe(true),
    );
  });

  it('strips losslessly and re-encodes only for orientation', async () => {
    const plainJpeg = await base().jpeg().toBuffer();
    const a = write('a.jpg', withSegments(plainJpeg, XMP_SEGMENT, IPTC_SEGMENT));
    const rotated = write(
      'r.jpg',
      await base(8, 6).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    );
    const logs: string[] = [];
    const r = await stripExifFiles([a, rotated], { log: (m) => logs.push(m) });
    expect(r.stripped).toBe(2);
    expect(fs.readFileSync(a).equals(plainJpeg)).toBe(true);
    const meta = await sharp(fs.readFileSync(rotated)).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([6, 8, undefined]);
    expect(logs).toEqual([
      `stripped: ${a} (XMP, IPTC)`,
      `stripped: ${rotated} (EXIF; re-encoded: orientation)`,
    ]);
  });

  it('reads the format from the bytes, not the extension (NX-110)', async () => {
    const jpg = withSegments(await base().jpeg().toBuffer(), XMP_SEGMENT);
    const png = await base()
      .withExif({ IFD0: { Make: 'Test' } })
      .png()
      .toBuffer();
    const webp = await base()
      .withExif({ IFD0: { Make: 'Test' } })
      .webp()
      .toBuffer();
    expect([sniffImageFormat(jpg), sniffImageFormat(png), sniffImageFormat(webp)]).toEqual([
      '.jpg',
      '.png',
      '.webp',
    ]);
    expect(sniffImageFormat(Buffer.from('not an image'))).toBeNull();

    const files = [write('a.png', jpg), write('b.webp', png), write('c.png', webp)];
    const logs: string[] = [];
    const r = await stripExifFiles(files, { log: (m) => logs.push(m) });
    expect([r.stripped, r.skipped]).toEqual([3, 0]);
    expect(logs).toEqual([
      `stripped: ${files[0]} (XMP; JPG data in a .png file)`,
      `stripped: ${files[1]} (EXIF; PNG data in a .webp file)`,
      `stripped: ${files[2]} (EXIF; WEBP data in a .png file)`,
    ]);
    expect(sniffImageFormat(fs.readFileSync(files[1]))).toBe('.png');
    for (const f of files) {
      expect((await sharp(fs.readFileSync(f)).metadata()).exif).toBeUndefined();
      expect(stripMetadataLossless(fs.readFileSync(f), '.jpg')?.blocks).toEqual([]);
    }
  });

  it('an unreadable file is still skipped with its extension named', async () => {
    const f = write(
      'broken.webp',
      // A chunk that claims more bytes than the file has.
      Buffer.concat([Buffer.from('RIFF0000WEBPVP8 ', 'latin1'), Buffer.from([0xff, 0xff, 0, 0])]),
    );
    const logs: string[] = [];
    const r = await stripExifFiles([f], { log: (m) => logs.push(m) });
    expect(r.skipped).toBe(1);
    expect(logs[0]).toContain('skipped (error)');
  });

  it('a text file under an image name is skipped as not an image', async () => {
    const f = write(
      'cover.webp',
      Buffer.from("<?xml version='1.0' encoding='UTF-8'?><Error><Code>AccessDenied</Code></Error>"),
    );
    const logs: string[] = [];
    const r = await stripExifFiles([f], { log: (m) => logs.push(m) });
    expect(r.skipped).toBe(1);
    expect(logs).toEqual([`skipped (error): ${f} — not an image (the file holds text)`]);
  });
});
