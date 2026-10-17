import { resolveCiContext } from '../../src/lib/utils/ci-resolve';

/** CI variables of the machine running the tests (e.g. GitHub Actions) would win over the ones set here. */
const CI_VAR = /^(GITHUB_|CI_|BITBUCKET_|CIRCLE_|BUILD_|GIT_)|^(BRANCH_NAME|CHANGE_BRANCH|HEAD)$/;

describe('resolveCiContext', () => {
  const ORIG_ENV = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !CI_VAR.test(k)),
  ) as NodeJS.ProcessEnv;
  const REAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIG_ENV };
  });
  afterAll(() => {
    process.env = REAL_ENV;
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it('reads BUILD_BRANCH first', () => {
    process.env = { ...ORIG_ENV, BUILD_BRANCH: 'feature/x' };
    expect(resolveCiContext().branch).toBe('feature/x');
  });

  it('falls back to BRANCH_NAME, then GIT_BRANCH, then CHANGE_BRANCH', () => {
    process.env = { ...ORIG_ENV, BUILD_BRANCH: '', BRANCH_NAME: 'develop' };
    expect(resolveCiContext().branch).toBe('develop');
    process.env = { ...ORIG_ENV, BRANCH_NAME: '', GIT_BRANCH: 'main' };
    expect(resolveCiContext().branch).toBe('main');
    process.env = { ...ORIG_ENV, GIT_BRANCH: '', CHANGE_BRANCH: 'pr/42' };
    expect(resolveCiContext().branch).toBe('pr/42');
  });

  it('strips origin/, refs/heads/, remotes/ prefixes', () => {
    process.env = { ...ORIG_ENV, BUILD_BRANCH: 'origin/feature/x' };
    expect(resolveCiContext().branch).toBe('feature/x');
    process.env = { ...ORIG_ENV, BUILD_BRANCH: 'refs/heads/main' };
    expect(resolveCiContext().branch).toBe('main');
    process.env = { ...ORIG_ENV, BUILD_BRANCH: 'remotes/upstream/develop' };
    expect(resolveCiContext().branch).toBe('upstream/develop');
  });

  it('reads BUILD_COMMIT first, falls back to GIT_COMMIT', () => {
    process.env = { ...ORIG_ENV, BUILD_COMMIT: 'abc1234' };
    expect(resolveCiContext().commit).toBe('abc1234');
    process.env = { ...ORIG_ENV, BUILD_COMMIT: '', GIT_COMMIT: 'def5678' };
    expect(resolveCiContext().commit).toBe('def5678');
  });

  it.each([
    ['GITHUB_HEAD_REF', 'feature/pr'],
    ['GITHUB_REF_NAME', 'main'],
    ['CI_COMMIT_REF_NAME', 'gitlab-branch'],
    ['BITBUCKET_BRANCH', 'bb-branch'],
    ['CIRCLE_BRANCH', 'circle-branch'],
    ['BUILD_SOURCEBRANCHNAME', 'azure-branch'],
  ])('reads the branch from %s', (name, value) => {
    process.env = {
      ...ORIG_ENV,
      BUILD_BRANCH: '',
      BRANCH_NAME: '',
      GIT_BRANCH: '',
      CHANGE_BRANCH: '',
      [name]: value,
    };
    expect(resolveCiContext({ git: () => 'local' }).branch).toBe(value);
  });

  it.each([
    'GITHUB_SHA',
    'CI_COMMIT_SHA',
    'BITBUCKET_COMMIT',
    'CIRCLE_SHA1',
    'BUILD_SOURCEVERSION',
  ])('reads the commit from %s as given', (name) => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    process.env = { ...ORIG_ENV, BUILD_COMMIT: '', GIT_COMMIT: '', [name]: sha };
    expect(resolveCiContext({ git: () => 'local' }).commit).toBe(sha);
  });

  it('reads BUILD_NUMBER then BUILD_ID then current timestamp', () => {
    process.env = { ...ORIG_ENV, BUILD_NUMBER: '42' };
    expect(resolveCiContext().buildNumber).toBe('42');
    process.env = { ...ORIG_ENV, BUILD_NUMBER: '', BUILD_ID: '99' };
    expect(resolveCiContext().buildNumber).toBe('99');
    process.env = { ...ORIG_ENV, BUILD_NUMBER: '', BUILD_ID: '' };
    const result = resolveCiContext().buildNumber;
    expect(Number.isFinite(parseInt(result, 10))).toBe(true);
  });

  it('returns "unknown" branch / commit when no env or git info is available', () => {
    process.env = {} as NodeJS.ProcessEnv;
    const ctx = resolveCiContext({ git: () => null });
    expect(ctx.branch).toBe('unknown');
    expect(ctx.commit).toBe('unknown');
  });
});
