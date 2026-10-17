import { Tree, updateJson, TargetConfiguration } from '@nx/devkit';

export function addProjectTarget(
  tree: Tree,
  projectPath: string,
  targetName: string,
  target: TargetConfiguration,
): void {
  updateJson(tree, `${projectPath}/project.json`, (json: Record<string, unknown>) => {
    const targets = (json['targets'] ?? {}) as Record<string, unknown>;
    if (targets[targetName]) {
      throw new Error(`addProjectTarget: target "${targetName}" already exists in ${projectPath}`);
    }
    targets[targetName] = target;
    json['targets'] = targets;
    return json;
  });
}

export function setProjectTags(tree: Tree, projectPath: string, tags: string[]): void {
  updateJson(tree, `${projectPath}/project.json`, (json: Record<string, unknown>) => {
    const existing = (json['tags'] as string[] | undefined) ?? [];
    json['tags'] = Array.from(new Set([...existing, ...tags]));
    return json;
  });
}
