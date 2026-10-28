import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import nxAnalyticsOff from '../../src/migrations/nx-analytics-off/nx-analytics-off';

describe('nx-analytics-off migration', () => {
  it('sets analytics false and keeps the rest of nx.json', async () => {
    const t = createTreeWithEmptyWorkspace();
    t.write('nx.json', '{\n  "npmScope": "acme",\n  "affected": { "defaultBase": "main" }\n}\n');
    await nxAnalyticsOff(t);
    const text = t.read('nx.json', 'utf8') ?? '';
    const nx = JSON.parse(text);
    expect(nx).toEqual({ npmScope: 'acme', affected: { defaultBase: 'main' }, analytics: false });
    expect(text).toContain('"affected": { "defaultBase": "main" }');
  });

  it('keeps an answer already given', async () => {
    const t = createTreeWithEmptyWorkspace();
    t.write('nx.json', '{\n  "analytics": true\n}\n');
    await nxAnalyticsOff(t);
    expect(t.read('nx.json', 'utf8')).toBe('{\n  "analytics": true\n}\n');
  });

  it('leaves workspaces without a readable nx.json alone', async () => {
    const t = createTreeWithEmptyWorkspace();
    t.delete('nx.json');
    await nxAnalyticsOff(t);
    expect(t.exists('nx.json')).toBe(false);
    t.write('nx.json', '{ // comment\n}\n');
    await nxAnalyticsOff(t);
    expect(t.read('nx.json', 'utf8')).toBe('{ // comment\n}\n');
  });
});
