import { readJson, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { INFRA_SCRIPTS, PREPUSH_V0_9_0 } from '../../src/generators/infra/generator';
import prepushAuditWarnOnly from '../../src/migrations/prepush-audit-warn-only/prepush-audit-warn-only';

function tree(scripts: Record<string, string>) {
  const t = createTreeWithEmptyWorkspace();
  updateJson(t, 'package.json', (j) => ({ ...j, scripts }));
  return t;
}
const scripts = (t: ReturnType<typeof tree>) => readJson(t, 'package.json').scripts;

describe('prepush-audit-warn-only migration', () => {
  it('rewrites the v0.9.0 default check:prepush and adds check:audit', async () => {
    expect(PREPUSH_V0_9_0).toBe('npm audit --omit=dev --audit-level=high && secretlint "**/*"');
    const t = tree({ 'check:prepush': PREPUSH_V0_9_0, lint: 'nx run-many -t lint' });
    await prepushAuditWarnOnly(t);
    expect(scripts(t)).toEqual({
      'check:prepush': INFRA_SCRIPTS['check:prepush'],
      'check:audit': 'npm audit --omit=dev --audit-level=high',
      lint: 'nx run-many -t lint',
    });
  });

  it('keeps a customised check:prepush but still adds check:audit', async () => {
    const t = tree({ 'check:prepush': 'secretlint "src/**/*"' });
    await prepushAuditWarnOnly(t);
    expect(scripts(t)).toEqual({
      'check:prepush': 'secretlint "src/**/*"',
      'check:audit': 'npm audit --omit=dev --audit-level=high',
    });
  });

  it('never replaces an existing check:audit', async () => {
    const t = tree({ 'check:prepush': PREPUSH_V0_9_0, 'check:audit': 'npm audit' });
    await prepushAuditWarnOnly(t);
    expect(scripts(t)['check:audit']).toBe('npm audit');
    expect(scripts(t)['check:prepush']).toBe(INFRA_SCRIPTS['check:prepush']);
  });

  it('leaves workspaces without the infra pre-push check alone', async () => {
    const t = tree({ lint: 'nx run-many -t lint' });
    const before = t.read('package.json', 'utf8');
    await prepushAuditWarnOnly(t);
    expect(t.read('package.json', 'utf8')).toBe(before);
  });

  it('is idempotent and tolerates a missing package.json', async () => {
    const t = tree({ 'check:prepush': PREPUSH_V0_9_0 });
    await prepushAuditWarnOnly(t);
    const once = t.read('package.json', 'utf8');
    await prepushAuditWarnOnly(t);
    expect(t.read('package.json', 'utf8')).toBe(once);
    const empty = createTreeWithEmptyWorkspace();
    empty.delete('package.json');
    await expect(prepushAuditWarnOnly(empty)).resolves.toBeUndefined();
  });

  it('is registered for 0.9.1', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const manifest = require('../../migrations.json');
    expect(manifest.generators['prepush-audit-warn-only']).toMatchObject({
      version: '0.9.1',
      implementation: './src/migrations/prepush-audit-warn-only/prepush-audit-warn-only',
    });
  });
});
