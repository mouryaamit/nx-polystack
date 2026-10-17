import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import libGenerator from '../../src/generators/lib/generator';
import { LibGeneratorSchema } from '../../src/generators/lib/schema.d';

const ROOT = 'libs/shared/orders';

describe('lib generator --type=state', () => {
  let tree: Tree;

  const read = (f: string): string => tree.read(`${ROOT}/${f}`, 'utf8') ?? '';
  const gen = (extra: Partial<LibGeneratorSchema> = {}) =>
    libGenerator(tree, { name: 'orders', type: 'state', ...extra });
  const pkg = (deps: Record<string, string> = {}) =>
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/source',
        dependencies: deps,
        devDependencies: { nx: '17.0.6' },
      }),
    );

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    pkg();
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('rejects --variant=signal-store with the Angular 16 reason', async () => {
    await expect(gen({ variant: 'signal-store' })).rejects.toThrow(
      'lib generator: --variant=signal-store needs Angular 16+ (signals); the generated libs ' +
        'target Angular 15. Use --variant=simple-service or ngrx.',
    );
  });

  it.each(['buildable', 'publishable', 'internal', 'akita'])(
    'rejects --variant=%s',
    async (variant) => {
      await expect(gen({ variant })).rejects.toThrow(/Use one of: simple-service, ngrx/);
    },
  );

  describe('simple-service (default)', () => {
    it('writes a generic Store<T> and an example feature store, no component', async () => {
      await gen();
      expect(read('src/index.ts')).toBe(
        "export * from './lib/store';\nexport * from './lib/orders.store';\n",
      );
      expect(tree.children(`${ROOT}/src/lib`).sort()).toEqual(['orders.store.ts', 'store.ts']);

      const store = read('src/lib/store.ts');
      expect(store).toContain('export class Store<T extends object>');
      expect(store).toContain('protected readonly state: BehaviorSubject<T>;');
      expect(store).toContain('readonly state$: Observable<T>;');
      expect(store).toContain('get snapshot(): T');
      expect(store).toContain('this.state$.pipe(map(selector), distinctUntilChanged())');
      expect(store).toContain('setState(update: Partial<T> | ((state: T) => Partial<T>)): void');

      const feature = read('src/lib/orders.store.ts');
      expect(feature).toContain("@Injectable({ providedIn: 'root' })");
      expect(feature).toContain('export class OrdersStore extends Store<OrdersState>');
      expect(feature).toContain('export interface OrdersState');
      expect(feature).toContain('export const initialOrdersState: OrdersState = {');
      expect(feature).toContain('super(initialOrdersState);');
      expect(feature).not.toMatch(/signal\(|\binject\(/);
      expect(read('README.md')).toContain('`--variant=simple-service`');
    });

    it('is always a buildable Angular lib and adds no NgRx', async () => {
      await gen();
      const pj = readJson(tree, `${ROOT}/project.json`);
      expect(pj.name).toBe('shared-orders');
      expect(pj.tags).toEqual(['scope:shared', 'type:state', 'platform:web']);
      expect(pj.targets.build.executor).toBe('@nx/angular:ng-packagr-lite');
      expect(tree.exists(`${ROOT}/ng-package.json`)).toBe(true);
      expect(readJson(tree, `${ROOT}/package.json`).peerDependencies).toEqual({
        '@angular/common': '^15.2.0',
        '@angular/core': '^15.2.0',
      });
      const deps = readJson(tree, 'package.json').dependencies;
      expect(deps['@ngrx/store']).toBeUndefined();
      expect(deps['@angular/core']).toBe('~15.2.0');
      expect(
        readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/shared-orders'],
      ).toEqual([`${ROOT}/src/index.ts`]);
    });
  });

  describe('ngrx', () => {
    it('writes actions, reducer, selectors, effects and the state module', async () => {
      await gen({ variant: 'ngrx' });
      expect(tree.children(`${ROOT}/src/lib`).sort()).toEqual([
        'orders-state.module.ts',
        'orders.actions.ts',
        'orders.effects.ts',
        'orders.models.ts',
        'orders.reducer.ts',
        'orders.selectors.ts',
      ]);
      const index = read('src/index.ts');
      for (const f of ['models', 'actions', 'reducer', 'selectors', 'effects']) {
        expect(index).toContain(`export * from './lib/orders.${f}';`);
      }
      expect(index).toContain("export * from './lib/orders-state.module';");

      const actions = read('src/lib/orders.actions.ts');
      expect(actions).toContain('export const OrdersActions = createActionGroup({');
      expect(actions).toContain("source: 'Orders',");
      expect(actions).toContain('Load: emptyProps(),');
      expect(actions).toContain("'Load Success': props<{ items: OrdersItem[] }>(),");

      const reducer = read('src/lib/orders.reducer.ts');
      expect(reducer).toContain("export const ORDERS_FEATURE_KEY = 'orders';");
      expect(reducer).toContain('export const ordersReducer = createReducer(');
      expect(reducer).toMatch(/on\(\s*OrdersActions.loadSuccess/);

      const selectors = read('src/lib/orders.selectors.ts');
      expect(selectors).toContain('createFeatureSelector<OrdersState>(ORDERS_FEATURE_KEY)');
      expect(selectors).toContain('export const selectOrdersItems = createSelector(');

      const effects = read('src/lib/orders.effects.ts');
      expect(effects).toContain('readonly load$ = createEffect(() =>');
      expect(effects).toContain('ofType(OrdersActions.load)');
      expect(effects).toContain('of<OrdersItem[]>([])');
      expect(effects).toContain('constructor(private readonly actions$: Actions) {}');

      const mod = read('src/lib/orders-state.module.ts');
      expect(mod).toContain('StoreModule.forFeature(ORDERS_FEATURE_KEY, ordersReducer)');
      expect(mod).toContain('EffectsModule.forFeature([OrdersEffects])');
      expect(mod).toContain('export class OrdersStateModule {}');

      const readme = read('README.md');
      expect(readme).toContain('StoreModule.forRoot({})');
      expect(readme).toContain('EffectsModule.forRoot([])');
    });

    it('uses constant/property/class names for multi-word names', async () => {
      await libGenerator(tree, { name: 'user-profile', type: 'state', variant: 'ngrx' });
      const r = 'libs/shared/user-profile/src/lib';
      expect(tree.read(`${r}/user-profile.reducer.ts`, 'utf8')).toContain(
        "export const USER_PROFILE_FEATURE_KEY = 'userProfile';",
      );
      expect(tree.read(`${r}/user-profile.actions.ts`, 'utf8')).toContain(
        "source: 'User Profile',",
      );
      expect(tree.exists(`${r}/user-profile-state.module.ts`)).toBe(true);
    });

    it('adds @ngrx/store and @ngrx/effects ~15.4.0 when Angular 15 is being added', async () => {
      await gen({ variant: 'ngrx' });
      const deps = readJson(tree, 'package.json').dependencies;
      expect(deps['@angular/core']).toBe('~15.2.0');
      expect(deps['@ngrx/store']).toBe('~15.4.0');
      expect(deps['@ngrx/effects']).toBe('~15.4.0');
      expect(readJson(tree, `${ROOT}/package.json`).peerDependencies).toEqual({
        '@angular/common': '^15.2.0',
        '@angular/core': '^15.2.0',
        '@ngrx/store': '^15.4.0',
        '@ngrx/effects': '^15.4.0',
      });
    });

    it('adds NgRx on an installed Angular 15 and keeps existing versions', async () => {
      pkg({ '@angular/core': '~15.1.0', '@ngrx/store': '15.3.0' });
      await gen({ variant: 'ngrx' });
      const deps = readJson(tree, 'package.json').dependencies;
      expect(deps['@ngrx/store']).toBe('15.3.0');
      expect(deps['@ngrx/effects']).toBe('~15.4.0');
    });

    it('warns and adds nothing on another Angular major', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      pkg({ '@angular/core': '^16.2.0', '@angular/common': '^16.2.0' });
      await gen({ variant: 'ngrx' });
      const deps = readJson(tree, 'package.json').dependencies;
      expect(deps['@ngrx/store']).toBeUndefined();
      expect(deps['@ngrx/effects']).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/Angular 16.*@ngrx\/store, @ngrx\/effects/),
      );
      expect(
        readJson(tree, `${ROOT}/package.json`).peerDependencies['@ngrx/store'],
      ).toBeUndefined();
    });
  });
});
