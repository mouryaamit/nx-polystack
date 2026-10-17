import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { DEV_GITHUB_REPO, setInstallSourceForTests } from '../../src/cli/install-source';
import pluginRepoDev, {
  renamePluginRepo,
} from '../../src/migrations/plugin-repo-dev/plugin-repo-dev';

describe('plugin-repo-dev migration (v0.38.2)', () => {
  it('renames the repo, not the package name or longer names', () => {
    expect(
      renamePluginRepo(
        'gh release view --repo mouryaamit/nx-polystack --json tagName\n' +
          'read access to mouryaamit/nx-polystack).\n' +
          'npm i @mouryaamit/nx-polystack@x\n' +
          'already example-org/private-plugin and mouryaamit/nx-polystack-sample\n' +
          'path @mouryaamit/nx-polystack/runtime\n' +
          'git clone https://github.com/mouryaamit/nx-polystack.git',
      ),
    ).toBe(
      'gh release view --repo example-org/private-plugin --json tagName\n' +
        'read access to example-org/private-plugin).\n' +
        'npm i @mouryaamit/nx-polystack@x\n' +
        'already example-org/private-plugin and mouryaamit/nx-polystack-sample\n' +
        'path @mouryaamit/nx-polystack/runtime\n' +
        'git clone https://github.com/example-org/private-plugin.git',
    );
  });

  it('updates workflow files only, and is idempotent', async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('.github/workflows/dependency-upgrade.yml', 'repo: mouryaamit/nx-polystack\n');
    tree.write('.github/workflows/notes.txt', 'mouryaamit/nx-polystack\n');
    tree.write('README.md', 'mouryaamit/nx-polystack\n');
    await pluginRepoDev(tree);
    await pluginRepoDev(tree);
    expect(tree.read('.github/workflows/dependency-upgrade.yml', 'utf-8')).toBe(
      'repo: example-org/private-plugin\n',
    );
    expect(tree.read('.github/workflows/notes.txt', 'utf-8')).toBe('mouryaamit/nx-polystack\n');
    expect(tree.read('README.md', 'utf-8')).toBe('mouryaamit/nx-polystack\n');
  });

  it('does nothing in the npm build, where the earlier name is the public repo', async () => {
    setInstallSourceForTests({ kind: 'npm' });
    try {
      const tree = createTreeWithEmptyWorkspace();
      tree.write('.github/workflows/x.yml', 'repo: mouryaamit/nx-polystack\n');
      await pluginRepoDev(tree);
      expect(tree.read('.github/workflows/x.yml', 'utf-8')).toBe('repo: mouryaamit/nx-polystack\n');
    } finally {
      setInstallSourceForTests({ kind: 'github', repo: DEV_GITHUB_REPO });
    }
  });

  it('does nothing without workflows', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await expect(pluginRepoDev(tree)).resolves.toBeUndefined();
  });
});
