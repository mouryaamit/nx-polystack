import { normalizeHost, normalizeHosts } from '../../src/lib/env-encryption/domains';

describe('domain normalisation', () => {
  it.each([
    ['Example.COM', 'example.com'],
    ['example.com.', 'example.com'],
    ['example.com:8443', 'example.com'],
    ['*.Example.com', '*.example.com'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['https://a.example.in/x', 'a.example.in'],
    ['*.example.com:443', '*.example.com'],
    ['10.0.0.1', '10.0.0.1'],
  ])('%s → %s', (input, out) => {
    expect(normalizeHost(input)).toBe(out);
  });

  it.each([
    '',
    'a b.com',
    '*',
    '*.',
    'exa*mple.com',
    'http://',
    '*.*.com',
    'user:pw@evil.com',
    'https://user@evil.com',
    'evil.com\\good.com',
    'evil.com/good.com',
    'evil.com?x=1',
    'evil.com#good.com',
    '*.com',
    '*.10.0.0.1',
    'example.com%2e',
  ])('rejects %p', (input) => {
    expect(normalizeHost(input)).toBeUndefined();
  });

  it('normalises a list, drops duplicates, names the bad entry', () => {
    expect(normalizeHosts(['a.com', 'A.com', 'b.in'])).toEqual(['a.com', 'b.in']);
    expect(() => normalizeHosts(['a.com', 'bad host'])).toThrow(/"bad host"/);
  });
});
