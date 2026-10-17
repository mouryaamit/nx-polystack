import { addDependenciesToPackageJson, readJson, Tree } from '@nx/devkit';

const PEERS: Record<string, string> = {
  sharp: '^0.33.0',
  'crypto-js': '^4.2.0',
};

/**
 * v0.3.0 made sharp and crypto-js optional peers, so npm no longer installs them automatically.
 * Add whichever the workspace does not already declare.
 */
export default async function addExecutorPeers(tree: Tree) {
  const pkg = readJson(tree, 'package.json');
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  const missing = Object.fromEntries(Object.entries(PEERS).filter(([name]) => !(name in declared)));
  if (Object.keys(missing).length === 0) return undefined;
  return addDependenciesToPackageJson(tree, {}, missing);
}
