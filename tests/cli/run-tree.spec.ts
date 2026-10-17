import * as fs from 'fs';
import * as path from 'path';

import { runInTree } from '../../src/cli/run-tree';

import { tmpDir } from './helpers';

describe('runInTree', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs a returned callback after files are written', async () => {
    const root = tmpDir();
    let existedWhenCalled = false;
    await runInTree(root, { dryRun: false, verbose: false }, (tree) => {
      tree.write('a.txt', 'hi');
      return () => {
        existedWhenCalled = fs.existsSync(path.join(root, 'a.txt'));
      };
    });
    expect(existedWhenCalled).toBe(true);
  });

  it('skips the callback and writes nothing on dry-run', async () => {
    const root = tmpDir();
    const cb = jest.fn();
    await runInTree(root, { dryRun: true, verbose: false }, (tree) => {
      tree.write('a.txt', 'hi');
      return cb;
    });
    expect(cb).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
  });
});
