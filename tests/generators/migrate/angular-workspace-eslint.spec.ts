import { withAngularLintExtends } from '../../../src/generators/migrate/angular-workspace/eslint';

describe('withAngularLintExtends', () => {
  it('adds the Angular rule sets to overrides that have none', () => {
    expect(
      withAngularLintExtends({
        extends: ['../../.eslintrc.json'],
        overrides: [
          { files: ['*.ts'], rules: { a: 'error' } },
          { files: ['*.html'], rules: {} },
          { files: ['*.ts'], extends: ['x'] },
          { files: ['*.json'] },
        ],
      }),
    ).toEqual({
      extends: ['../../.eslintrc.json'],
      overrides: [
        {
          files: ['*.ts'],
          rules: { a: 'error' },
          extends: [
            'plugin:@nx/angular',
            'plugin:@angular-eslint/template/process-inline-templates',
          ],
        },
        { files: ['*.html'], rules: {}, extends: ['plugin:@nx/angular-template'] },
        { files: ['*.ts'], extends: ['x'] },
        { files: ['*.json'] },
      ],
    });
  });

  it('leaves a config without overrides alone', () => {
    expect(withAngularLintExtends({ rules: {} })).toEqual({ rules: {} });
  });
});
