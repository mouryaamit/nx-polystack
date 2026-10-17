import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { refreshNgswHashes } from '../../src/lib/hardening/ngsw';

const sha1 = (text: string) => crypto.createHash('sha1').update(text).digest('hex');

describe('refreshNgswHashes', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-ngsw-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  const ngsw = () => JSON.parse(fs.readFileSync(path.join(root, 'ngsw.json'), 'utf8'));

  it('returns 0 without ngsw.json', () => {
    expect(refreshNgswHashes(root)).toBe(0);
  });

  it('recomputes hashes of changed files under the base href, leaves missing files alone', () => {
    write('main.js', 'new main');
    write('index.html', '<html></html>');
    write('assets/a b.png', 'img');
    const original = {
      configVersion: 1,
      index: '/app/index.html',
      hashTable: {
        '/app/main.js': sha1('old main'),
        '/app/index.html': sha1('<html></html>'),
        '/app/assets/a%20b.png': 'stale',
        '/app/gone.js': 'keep-me',
        '/other/x.js': 'outside',
      },
    };
    write('ngsw.json', JSON.stringify(original, null, 2) + '\n');

    expect(refreshNgswHashes(root)).toBe(2);
    const out = ngsw();
    expect(out.hashTable['/app/main.js']).toBe(sha1('new main'));
    expect(out.hashTable['/app/index.html']).toBe(sha1('<html></html>'));
    expect(out.hashTable['/app/assets/a%20b.png']).toBe(sha1('img'));
    expect(out.hashTable['/app/gone.js']).toBe('keep-me');
    expect(out.hashTable['/other/x.js']).toBe('outside');
    expect(fs.readFileSync(path.join(root, 'ngsw.json'), 'utf8').endsWith('}\n')).toBe(true);
  });

  it('does not rewrite ngsw.json when every hash matches', () => {
    write('main.js', 'm');
    const text = JSON.stringify({ index: '/index.html', hashTable: { '/main.js': sha1('m') } });
    write('ngsw.json', text);
    expect(refreshNgswHashes(root)).toBe(0);
    expect(fs.readFileSync(path.join(root, 'ngsw.json'), 'utf8')).toBe(text);
  });
});
