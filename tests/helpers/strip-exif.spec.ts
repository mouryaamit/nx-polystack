import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Untyped on purpose: sharp 0.35 declares its types as an ES module that TypeScript 4.9 reads
// without a call signature.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const sharp = require('sharp') as any;
import { stripExif } from '../../src/lib/helpers/strip-exif';

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

    const before = await sharp(file).metadata();
    expect(before.exif?.length).toBeGreaterThan(0);

    await stripExif({ rootDir: tmpDir });

    const after = await sharp(file).metadata();
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
    const after = await sharp(file).metadata();
    expect(after.exif).toBeUndefined();
  });

  it('leaves unsupported file types alone', async () => {
    const file = path.join(tmpDir, 'data.txt');
    fs.writeFileSync(file, 'hello');
    await stripExif({ rootDir: tmpDir });
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  });
});
