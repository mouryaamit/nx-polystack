import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import githubActionsNode24, {
  bumpWorkflowActions,
} from '../../src/migrations/github-actions-node24/github-actions-node24';

const OLD = `steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      cache: npm
  - name: Nx cache
    uses: actions/cache@v4
  - uses: nrwl/nx-set-shas@v4
  - uses: 'peter-evans/create-pull-request@v6'
  - uses: subosito/flutter-action@v2
`;

describe('github-actions-node24 migration (v1.0.2)', () => {
  it('moves the plugin workflow actions to their Node 24 majors', () => {
    expect(bumpWorkflowActions(OLD)).toBe(`steps:
  - uses: actions/checkout@v5
  - uses: actions/setup-node@v5
    with:
      cache: npm
  - name: Nx cache
    uses: actions/cache@v5
  - uses: nrwl/nx-set-shas@v5
  - uses: 'peter-evans/create-pull-request@v8'
  - uses: subosito/flutter-action@v2
`);
  });

  it.each([
    'uses: actions/checkout@v4.1.7',
    'uses: actions/checkout@v3',
    'uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11',
    'uses: my-org/actions/checkout@v4',
    '# actions/checkout@v4 in a comment',
  ])('leaves %s alone', (line) => {
    expect(bumpWorkflowActions(line)).toBe(line);
  });

  it('rewrites only workflow YAML files, idempotently', async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('.github/workflows/ci.yml', OLD);
    tree.write('.github/workflows/notes.md', 'uses: actions/checkout@v4');
    tree.write('docs/ci.yml', 'uses: actions/checkout@v4');
    await githubActionsNode24(tree);
    const once = tree.read('.github/workflows/ci.yml', 'utf-8');
    await githubActionsNode24(tree);
    expect(tree.read('.github/workflows/ci.yml', 'utf-8')).toBe(once);
    expect(once).toContain('actions/checkout@v5');
    expect(tree.read('.github/workflows/notes.md', 'utf-8')).toBe('uses: actions/checkout@v4');
    expect(tree.read('docs/ci.yml', 'utf-8')).toBe('uses: actions/checkout@v4');
  });

  it('does nothing without .github/workflows', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await expect(githubActionsNode24(tree)).resolves.toBeUndefined();
  });
});
