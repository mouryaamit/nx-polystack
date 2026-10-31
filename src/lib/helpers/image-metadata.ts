import * as zlib from 'zlib';

/**
 * Lossless removal of EXIF, XMP and IPTC blocks from JPEG, PNG and WebP files: the blocks are cut
 * out and every other byte (the compressed image, ICC profiles, other chunks) is kept as it was.
 */

export type MetadataBlock = 'EXIF' | 'XMP' | 'IPTC';

export interface MetadataScan {
  /** Blocks found (each name once, in the order EXIF, XMP, IPTC). */
  blocks: MetadataBlock[];
  /** EXIF orientation (1-8); 1 when there is none. */
  orientation: number;
  /** The file without those blocks (the input itself when there were none). */
  out: Buffer;
}

const ORDER: MetadataBlock[] = ['EXIF', 'XMP', 'IPTC'];
const sorted = (found: Set<MetadataBlock>) => ORDER.filter((b) => found.has(b));

/** EXIF orientation from TIFF data (`II*\0` / `MM\0*` header); 1 when absent or unreadable. */
export function tiffOrientation(tiff: Buffer): number {
  if (tiff.length >= 6 && tiff.toString('latin1', 0, 6) === 'Exif\0\0') tiff = tiff.subarray(6);
  if (tiff.length < 8) return 1;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const le = order === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

const startsWith = (b: Buffer, at: number, s: string) =>
  b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;

/** JPEG: APP1 Exif and XMP segments, APP13 Photoshop segments holding IPTC (8BIM 0x0404). */
function jpeg(buf: Buffer): MetadataScan | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const found = new Set<MetadataBlock>();
  let orientation = 1;
  const keep: Buffer[] = [buf.subarray(0, 2)];
  let pos = 2;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) return null; // not a marker: not a JPEG we can read
    let m = pos + 1;
    while (m < buf.length && buf[m] === 0xff) m++; // fill bytes
    const marker = buf[m];
    if (marker === undefined) return null;
    if (marker === 0xda || marker === 0xd9) {
      keep.push(buf.subarray(pos));
      pos = buf.length;
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      keep.push(buf.subarray(pos, m + 1));
      pos = m + 1;
      continue;
    }
    if (m + 3 > buf.length) return null;
    const len = buf.readUInt16BE(m + 1);
    const end = m + 1 + len;
    if (len < 2 || end > buf.length) return null;
    const data = buf.subarray(m + 3, end);
    let drop: MetadataBlock | undefined;
    if (marker === 0xe1 && startsWith(data, 0, 'Exif\0\0')) {
      drop = 'EXIF';
      orientation = tiffOrientation(data.subarray(6));
    } else if (
      marker === 0xe1 &&
      (startsWith(data, 0, 'http://ns.adobe.com/xap/1.0/\0') ||
        startsWith(data, 0, 'http://ns.adobe.com/xmp/extension/\0'))
    ) {
      drop = 'XMP';
    } else if (
      marker === 0xed &&
      startsWith(data, 0, 'Photoshop 3.0\0') &&
      data.includes(Buffer.from('8BIM\x04\x04', 'latin1'))
    ) {
      drop = 'IPTC';
    }
    if (drop) found.add(drop);
    else keep.push(buf.subarray(pos, end));
    pos = end;
  }
  const blocks = sorted(found);
  return { blocks, orientation, out: blocks.length ? Buffer.concat(keep) : buf };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Text of a tEXt / zTXt / iTXt chunk after its keyword (inflated when compressed), or null. */
function pngText(type: string, data: Buffer, keywordEnd: number): Buffer | null {
  try {
    if (type === 'tEXt') return data.subarray(keywordEnd + 1);
    if (type === 'zTXt') return zlib.inflateSync(data.subarray(keywordEnd + 2));
    // iTXt: keyword\0 flag method lang\0 translated\0 text
    const flag = data[keywordEnd + 1];
    let p = data.indexOf(0, keywordEnd + 3);
    if (p < 0) return null;
    p = data.indexOf(0, p + 1);
    if (p < 0) return null;
    const text = data.subarray(p + 1);
    return flag === 1 ? zlib.inflateSync(text) : text;
  } catch {
    return null;
  }
}

/** ImageMagick "Raw profile type exif": `\nexif\n   <length>\n<hex lines>` → bytes. */
function rawProfileBytes(text: Buffer): Buffer {
  const lines = text.toString('latin1').trim().split('\n');
  return Buffer.from(lines.slice(2).join('').replace(/\s+/g, ''), 'hex');
}

/** PNG: eXIf chunks, XMP text chunks, ImageMagick raw EXIF / IPTC / XMP profiles. */
function png(buf: Buffer): MetadataScan | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const found = new Set<MetadataBlock>();
  let orientation = 1;
  const keep: Buffer[] = [buf.subarray(0, 8)];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const end = pos + 12 + len;
    if (end > buf.length) return null;
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    let drop: MetadataBlock | undefined;
    if (type === 'eXIf') {
      drop = 'EXIF';
      orientation = tiffOrientation(data);
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const k = data.indexOf(0);
      const keyword = k > 0 ? data.toString('latin1', 0, k) : '';
      if (keyword === 'XML:com.adobe.xmp' || keyword === 'Raw profile type xmp') drop = 'XMP';
      else if (keyword === 'Raw profile type iptc' || keyword === 'Raw profile type 8bim') {
        drop = 'IPTC';
      } else if (keyword === 'Raw profile type exif' || keyword === 'Raw profile type APP1') {
        drop = 'EXIF';
        const text = pngText(type, data, k);
        if (text) orientation = tiffOrientation(rawProfileBytes(text));
      }
    }
    if (drop) found.add(drop);
    else keep.push(buf.subarray(pos, end));
    pos = end;
    if (type === 'IEND') break;
  }
  if (pos < buf.length) keep.push(buf.subarray(pos));
  const blocks = sorted(found);
  return { blocks, orientation, out: blocks.length ? Buffer.concat(keep) : buf };
}

/** WebP: EXIF and XMP chunks; their VP8X flags are cleared and the RIFF size fixed. */
function webp(buf: Buffer): MetadataScan | null {
  if (buf.length < 12 || !startsWith(buf, 0, 'RIFF') || !startsWith(buf, 8, 'WEBP')) return null;
  const found = new Set<MetadataBlock>();
  let orientation = 1;
  const keep: Buffer[] = [];
  let vp8x = -1;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const type = buf.toString('latin1', pos, pos + 4);
    const len = buf.readUInt32LE(pos + 4);
    const end = Math.min(buf.length, pos + 8 + len + (len % 2));
    if (pos + 8 + len > buf.length) return null;
    if (type === 'EXIF') {
      found.add('EXIF');
      orientation = tiffOrientation(buf.subarray(pos + 8, pos + 8 + len));
    } else if (type === 'XMP ') {
      found.add('XMP');
    } else {
      if (type === 'VP8X') vp8x = keep.length;
      keep.push(buf.subarray(pos, end));
    }
    pos = end;
  }
  const blocks = sorted(found);
  if (blocks.length === 0) return { blocks, orientation, out: buf };
  if (vp8x >= 0) {
    const chunk = Buffer.from(keep[vp8x]);
    chunk[8] &= ~(0x08 | 0x04); // EXIF and XMP flags
    keep[vp8x] = chunk;
  }
  const body = Buffer.concat(keep);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return { blocks, orientation, out: Buffer.concat([header, body]) };
}

export type ImageFormat = '.jpg' | '.png' | '.webp';

/**
 * The image format the bytes start with (JPEG FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A, RIFF....WEBP),
 * whatever the file is named; null for anything else.
 */
export function sniffImageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return '.png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return '.webp';
  }
  return null;
}

/**
 * The file's EXIF/XMP/IPTC blocks and the file without them. The format comes from the bytes
 * (a PNG named .webp is read as PNG); the extension (.jpg/.jpeg, .png, .webp) is used only when
 * the bytes are not one of them. Null when the file cannot be read.
 */
export function stripMetadataLossless(buf: Buffer, ext: string): MetadataScan | null {
  switch (sniffImageFormat(buf) ?? ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return jpeg(buf);
    case '.png':
      return png(buf);
    case '.webp':
      return webp(buf);
    default:
      return null;
  }
}
