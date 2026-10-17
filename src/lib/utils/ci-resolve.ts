import { execSync } from 'child_process';

export interface CiContext {
  branch: string;
  commit: string;
  buildNumber: string;
}

export interface CiContextOptions {
  /** Override how git is invoked (for tests). Returns trimmed stdout, or null on failure. */
  git?: (cmd: string) => string | null;
}

const defaultGit = (cmd: string): string | null => {
  try {
    return (
      execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
};

const stripBranchPrefixes = (b: string): string =>
  b
    .replace(/^origin\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^remotes\//, '');

export function resolveCiContext(opts: CiContextOptions = {}): CiContext {
  const git = opts.git ?? defaultGit;

  let branch =
    process.env['BUILD_BRANCH'] ||
    process.env['BRANCH_NAME'] ||
    process.env['GIT_BRANCH'] ||
    process.env['CHANGE_BRANCH'] ||
    process.env['GITHUB_HEAD_REF'] ||
    process.env['GITHUB_REF_NAME'] ||
    process.env['CI_COMMIT_REF_NAME'] ||
    process.env['BITBUCKET_BRANCH'] ||
    process.env['CIRCLE_BRANCH'] ||
    process.env['BUILD_SOURCEBRANCHNAME'] ||
    git('git rev-parse --abbrev-ref HEAD') ||
    'unknown';

  if (branch === 'HEAD') {
    branch = git('git name-rev --name-only HEAD') || 'unknown';
  }
  branch = stripBranchPrefixes(branch);

  const ciCommit =
    process.env['BUILD_COMMIT'] ||
    process.env['GIT_COMMIT'] ||
    process.env['GITHUB_SHA'] ||
    process.env['CI_COMMIT_SHA'] ||
    process.env['BITBUCKET_COMMIT'] ||
    process.env['CIRCLE_SHA1'] ||
    process.env['BUILD_SOURCEVERSION'];
  // Used as given: the encryption key and the meta tag take the same value, so they always match.
  const commit = ciCommit || git('git rev-parse --short HEAD') || 'unknown';

  const buildNumber = process.env['BUILD_NUMBER'] || process.env['BUILD_ID'] || String(Date.now());

  return { branch, commit, buildNumber };
}
