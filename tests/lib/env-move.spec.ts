import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { applyEnvMoves, envMoveNote, moveAngularEnvFiles } from '../../src/lib/utils/env-move';

const PJ = 'apps/portal/project.json';

function app(tree: Tree, envDir = 'apps/portal/src/environments'): void {
  tree.write(
    PJ,
    JSON.stringify({
      name: 'portal',
      targets: {
        build: {
          executor: '@angular-devkit/build-angular:browser',
          configurations: {
            production: {
              fileReplacements: [
                { replace: `${envDir}/environment.ts`, with: `${envDir}/environment.prod.ts` },
                { replace: 'apps/portal/src/config.ts', with: 'apps/portal/src/config.prod.ts' },
              ],
            },
          },
        },
        release: {
          executor: '@mouryaamit/nx-polystack:build',
          options: { envProject: 'old' },
          configurations: { prod: { env: 'PROD' } },
        },
      },
    }),
  );
  tree.write(`${envDir}/environment.ts`, 'export const environment = {};\n');
  tree.write(
    `${envDir}/environment.prod.ts`,
    "import { base } from './environment';\nexport const environment = base;\n",
  );
  tree.write(`${envDir}/README.md`, 'notes\n');
  tree.write(
    'apps/portal/src/app/app.component.ts',
    "import { environment } from '../environments/environment';\nimport { x } from './x';\n",
  );
  tree.write(
    'libs/shared/src/api.ts',
    "import { environment } from '../../../apps/portal/src/environments/environment.prod';\n",
  );
}

describe('moveAngularEnvFiles', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('moves environment*.ts to environments/<envProject>/ and updates replacements, release and imports', () => {
    app(tree);
    const r = moveAngularEnvFiles(tree, PJ, 'portal');
    expect(r.moved.map(([, to]) => to)).toEqual([
      'environments/portal/environment.prod.ts',
      'environments/portal/environment.ts',
    ]);
    // Their own relative imports still hold: they moved together.
    expect(tree.read('environments/portal/environment.prod.ts', 'utf8')).toContain(
      "from './environment'",
    );
    // Other files in the folder stay.
    expect(tree.exists('apps/portal/src/environments/README.md')).toBe(true);
    const pj = readJson(tree, PJ);
    expect(pj.targets.build.configurations.production.fileReplacements).toEqual([
      {
        replace: 'environments/portal/environment.ts',
        with: 'environments/portal/environment.prod.ts',
      },
      { replace: 'apps/portal/src/config.ts', with: 'apps/portal/src/config.prod.ts' },
    ]);
    expect(pj.targets.release.options.envProject).toBe('portal');
    expect(tree.read('apps/portal/src/app/app.component.ts', 'utf8')).toBe(
      "import { environment } from '../../../../environments/portal/environment';\nimport { x } from './x';\n",
    );
    expect(tree.read('libs/shared/src/api.ts', 'utf8')).toBe(
      "import { environment } from '../../../environments/portal/environment.prod';\n",
    );
    expect(envMoveNote(r)).toBe(
      'env files moved from `apps/portal/src/environments/` to `environments/portal/` ' +
        '(`environment.prod.ts`, `environment.ts`); fileReplacements updated, imports updated in ' +
        '`apps/portal/src/app/app.component.ts`, `libs/shared/src/api.ts`',
    );
  });

  it('moves nothing when a target file exists', () => {
    app(tree);
    tree.write('environments/portal/environment.prod.ts', '// mine\n');
    const r = moveAngularEnvFiles(tree, PJ, 'portal');
    expect(r.moved).toEqual([]);
    expect(tree.exists('apps/portal/src/environments/environment.ts')).toBe(true);
    expect(tree.read('environments/portal/environment.prod.ts', 'utf8')).toBe('// mine\n');
    expect(readJson(tree, PJ).targets.release.options.envProject).toBe('old');
    expect(envMoveNote(r)).toContain(
      'env files were left in `apps/portal/src/environments/`: `environments/portal/environment.prod.ts` already exist',
    );
  });

  it('moves nothing when the replacements use more than one folder', () => {
    app(tree);
    const pj = readJson(tree, PJ);
    pj.targets.build.configurations.uat = {
      fileReplacements: [
        {
          replace: 'apps/portal/src/env2/environment.ts',
          with: 'apps/portal/src/env2/environment.uat.ts',
        },
      ],
    };
    tree.write(PJ, JSON.stringify(pj));
    const r = moveAngularEnvFiles(tree, PJ, 'portal');
    expect(r.moved).toEqual([]);
    expect(envMoveNote(r)).toContain('the fileReplacements use more than one folder');
  });

  it('does nothing for projects already using environments/ or without env replacements', () => {
    app(tree, 'environments/portal');
    expect(envMoveNote(moveAngularEnvFiles(tree, PJ, 'portal'))).toBeUndefined();
    tree.write('libs/ui/project.json', JSON.stringify({ name: 'ui', targets: {} }));
    expect(envMoveNote(moveAngularEnvFiles(tree, 'libs/ui/project.json', 'ui'))).toBeUndefined();
  });

  it('applyEnvMoves runs the recorded moves and adds labelled notes', () => {
    app(tree);
    const data = {
      notes: [] as string[],
      envMoves: [
        { projectJson: PJ, envProject: 'portal', label: '`portal`' },
        { projectJson: 'apps/gone/project.json', envProject: 'gone' },
      ],
    };
    applyEnvMoves(tree, data);
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0]).toMatch(/^`portal`: env files moved from/);
  });

  it('applyEnvMoves without moving (--no-rewrite-imports) leaves the files and says where they belong', () => {
    app(tree);
    const data = { notes: [] as string[], envMoves: [{ projectJson: PJ, envProject: 'portal' }] };
    applyEnvMoves(tree, data, false);
    expect(tree.exists('apps/portal/src/environments/environment.ts')).toBe(true);
    expect(data.notes[0]).toContain('Env files were left in the project');
    expect(data.notes[0]).toContain('`environments/portal/`');
  });
});
