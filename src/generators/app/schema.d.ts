export interface AppGeneratorSchema {
  name: string;
  type: 'flutter' | 'angular' | 'ionic';
  /** Folder under apps/ (kebab-case segments, at most 3): the app goes to apps/<dir>/<name>. */
  dir?: string;
  /** Ionic only — Capacitor appId (reverse-DNS). Default: com.example.<name without dashes>. */
  appId?: string;
  i18n?: string[];
  push?: 'none' | 'fcm';
  deeplink?: string;
  tags?: string[];
  cspConnectSrc?: string;
  /** Base href of the uat and prod release configurations (e.g. /portal/). */
  baseHref?: string;
  /** Dev-server port (default: the lowest free port from 4200 among the workspace's apps). */
  port?: number;
  /** Angular/Ionic: `per-env` gives environment.{dev,uat,prod}.ts and a shared environments/environment.ts. */
  envLayout?: 'default' | 'per-env';
  /** Create the app from this existing app (copy, rename, empty env values). */
  from?: string;
  /** With `from`: environments to keep (default all; dev is always kept). */
  envs?: string[] | string;
  /** With `from`: keep or clear the base app's CSP allowlist. */
  csp?: 'keep' | 'clear';
}
