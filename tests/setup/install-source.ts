import { DEV_GITHUB_REPO, setInstallSourceForTests } from '../../src/cli/install-source';

// Tests describe the development build (GitHub source) whatever package.json says, so they pass
// unchanged in the public export, whose package.json says npm. Tests of the npm build set it.
setInstallSourceForTests({ kind: 'github', repo: DEV_GITHUB_REPO });
