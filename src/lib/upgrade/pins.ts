/**
 * The versions `pstack upgrade angular` moves a workspace to, one Angular major per step. Proven
 * by the NX-72 walk (Angular 15 → 21 with web, Ionic/Capacitor and standalone migration).
 *
 * Version strings with a dot are pinned with `~`; a bare major (e.g. "21") with `^<major>.0.0`.
 */
export interface AngularPins {
  /** @angular/core and the Angular build packages. */
  angular: string;
  /** Nx the step migrates to (16 stays on Nx 17.0: `nx migrate @angular/core@16`). */
  nx: string;
  typescript: string;
  /** @ionic/angular; "9" is reached through `@ionic/migrate`. */
  ionic: string;
  /** Capacitor major for each Ionic app's own package.json. */
  capacitor: number;
  /** Node major the workspace declares (engines.node and .nvmrc). */
  node: number;
  angularEslint: string;
}

export const ANGULAR_PINS: Readonly<Record<number, AngularPins>> = {
  15: {
    angular: '15.2.10',
    nx: '17.0.6',
    typescript: '4.9.5',
    ionic: '7.8.6',
    capacitor: 5,
    node: 20,
    angularEslint: '15.2.1',
  },
  16: {
    angular: '16.2.12',
    nx: '17.0.6',
    typescript: '5.1.6',
    ionic: '7.8.6',
    capacitor: 6,
    node: 20,
    angularEslint: '16.3.1',
  },
  17: {
    angular: '17.3.12',
    nx: '18.3.5',
    typescript: '5.4.5',
    ionic: '7.8.6',
    capacitor: 6,
    node: 20,
    angularEslint: '17.3.0',
  },
  18: {
    angular: '18.2.14',
    nx: '19.8.14',
    typescript: '5.5.4',
    ionic: '8.7.11',
    capacitor: 7,
    node: 20,
    angularEslint: '18.4.3',
  },
  19: {
    angular: '19.2.25',
    nx: '20.8.4',
    typescript: '5.8.3',
    ionic: '8.7.11',
    capacitor: 7,
    node: 20,
    angularEslint: '19.8.1',
  },
  20: {
    angular: '20.3.32',
    nx: '21.6.11',
    typescript: '5.9.3',
    ionic: '8.7.11',
    capacitor: 7,
    node: 20,
    angularEslint: '20.7.0',
  },
  21: {
    angular: '21.2.24',
    nx: '22.7.12',
    typescript: '5.9.3',
    ionic: '9',
    capacitor: 8,
    node: 22,
    angularEslint: '21',
  },
};

export const MIN_ANGULAR = 15;
export const MAX_ANGULAR = 21;

/**
 * The step that runs Angular's inject() migration (`@angular/core:inject`): angular-eslint 20 turns
 * on `@angular-eslint/prefer-inject` as an error, so constructor parameter injection stops linting.
 */
export const INJECT_MIGRATION_ANGULAR = 20;

/** The first Angular major whose Nx step needs the second `nx migrate @angular/core` pass. */
export const NX_SKIPS_ANGULAR_FROM = 21;

/** npm range for a pin: "5.4.5" → "~5.4.5", "21" → "^21.0.0". */
export function pinRange(pin: string): string {
  return pin.includes('.') ? `~${pin}` : `^${pin}.0.0`;
}

/** Major of a version or range ("~17.3.0", "^16.2.12", "17.3.9", "20"); undefined if none. */
export function majorOfSpec(spec: string | undefined): number | undefined {
  const m = spec === undefined ? null : /(\d+)/.exec(spec);
  return m ? Number(m[1]) : undefined;
}
