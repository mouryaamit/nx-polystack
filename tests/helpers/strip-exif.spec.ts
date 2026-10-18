import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Untyped on purpose: sharp 0.35 declares its types as an ES module that TypeScript 4.9 reads
// without a call signature.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const sharp = require('sharp') as any;
import { stripExif, stripExifSummary } from '../../src/lib/helpers/strip-exif';

// Read files through a buffer: sharp caches by path and can return the metadata it read before.
const meta = (file: string) => sharp(fs.readFileSync(file)).metadata();

describe('stripExif', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-exif-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes EXIF metadata from a JPEG', async () => {
    const file = path.join(tmpDir, 'photo.jpg');
    const buf = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .withExif({ IFD0: { Make: 'Test', Model: 'X' } })
      .jpeg()
      .toBuffer();
    fs.writeFileSync(file, buf);

    const before = await meta(file);
    expect(before.exif?.length).toBeGreaterThan(0);

    await stripExif({ rootDir: tmpDir });

    const after = await meta(file);
    expect(after.exif).toBeUndefined();
  });

  it('walks recursively into subdirectories', async () => {
    const sub = path.join(tmpDir, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    const file = path.join(sub, 'photo.jpg');
    const buf = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .withExif({ IFD0: { Make: 'Foo' } })
      .jpeg()
      .toBuffer();
    fs.writeFileSync(file, buf);

    await stripExif({ rootDir: tmpDir });
    const after = await meta(file);
    expect(after.exif).toBeUndefined();
  });

  it('leaves unsupported file types alone', async () => {
    const file = path.join(tmpDir, 'data.txt');
    fs.writeFileSync(file, 'hello');
    await stripExif({ rootDir: tmpDir });
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  });

  const base = (w = 8, h = 6) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 90 } } });
  const write = (name: string, buf: Buffer) => {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, buf);
    return file;
  };
  const past = new Date('2020-01-01T00:00:00Z');

  it.each([
    ['plain.png', () => base().png().toBuffer()],
    ['plain.jpg', () => base().jpeg({ quality: 60 }).toBuffer()],
    ['plain.jpeg', () => base().jpeg({ quality: 60 }).toBuffer()],
    ['plain.webp', () => base().webp({ quality: 50 }).toBuffer()],
    ['palette.png', () => base().png({ palette: true, colours: 4 }).toBuffer()],
  ])('leaves %s without EXIF byte-identical and untouched', async (name, make) => {
    const bytes: Buffer = await make();
    const file = write(name, bytes);
    fs.utimesSync(file, past, past);

    const r = await stripExif({ rootDir: tmpDir });

    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(past.getTime());
    expect(r).toEqual({ scanned: 1, stripped: 0, unchanged: 1, skipped: 0 });
  });

  it.each([
    [
      'exif.png',
      'png',
      () =>
        base()
          .withExif({ IFD0: { Make: 'T' } })
          .png()
          .toBuffer(),
    ],
    [
      'exif.jpg',
      'jpeg',
      () =>
        base()
          .withExif({ IFD0: { Make: 'T' } })
          .jpeg()
          .toBuffer(),
    ],
    [
      'exif.webp',
      'webp',
      () =>
        base()
          .withExif({ IFD0: { Make: 'T' } })
          .webp()
          .toBuffer(),
    ],
  ])('strips %s and keeps format and size', async (name, format, make) => {
    const file = write(name, await make());
    expect((await meta(file)).exif?.length).toBeGreaterThan(0);

    const r = await stripExif({ rootDir: tmpDir });

    const after = await meta(file);
    expect(after.exif).toBeUndefined();
    expect(after.format).toBe(format);
    expect([after.width, after.height]).toEqual([8, 6]);
    expect(r.stripped).toBe(1);
  });

  it('changes only the images with EXIF in a mixed folder and counts them', async () => {
    const plain = await base().png().toBuffer();
    const plainFile = write('a.png', plain);
    write(
      'b.jpg',
      await base()
        .withExif({ IFD0: { Make: 'T' } })
        .jpeg()
        .toBuffer(),
    );
    write('broken.png', Buffer.from('not an image'));
    write('notes.txt', Buffer.from('x'));
    const logs: string[] = [];

    const r = await stripExif({ rootDir: tmpDir, log: (m) => logs.push(m) });

    expect(fs.readFileSync(plainFile).equals(plain)).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'broken.png'), 'utf8')).toBe('not an image');
    expect(r).toEqual({ scanned: 3, stripped: 1, unchanged: 1, skipped: 1 });
    expect(logs.some((l) => l.startsWith('skipped (error):') && l.includes('broken.png'))).toBe(
      true,
    );
    expect(stripExifSummary(r)).toBe('strip-exif: 3 scanned, 1 stripped, 1 unchanged, 1 skipped');
  });

  it('keeps the EXIF orientation in the pixels of a stripped image', async () => {
    const file = write(
      'rotated.jpg',
      await base(8, 6).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    );
    await stripExif({ rootDir: tmpDir });
    const after = await meta(file);
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect([after.width, after.height]).toEqual([6, 8]);
  });
});
