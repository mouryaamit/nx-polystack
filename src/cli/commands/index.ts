import { CommandContext } from '../types';

export type CommandHandler = (ctx: CommandContext) => Promise<number>;

export const COMMANDS: Record<string, CommandHandler> = {
  preset: async (c) => (await import('./preset')).runPreset(c),
  new: async (c) => (await import('./new')).runNew(c),
  app: async (c) => (await import('./app')).runApp(c),
  env: async (c) => (await import('./env')).runEnv(c),
  lib: async (c) => (await import('./lib')).runLib(c),
  llm: async (c) => (await import('./llm')).runLlm(c),
  encryption: async (c) => (await import('./encryption')).runEncryption(c),
  hardening: async (c) => (await import('./hardening')).runHardening(c),
  build: async (c) => (await import('./build')).runBuild(c),
  release: async (c) => (await import('./release')).runRelease(c),
  csp: async (c) => (await import('./csp')).runCsp(c),
  shared: async (c) => (await import('./shared')).runShared(c),
  infra: async (c) => (await import('./infra')).runInfra(c),
  _migrate: async (c) => (await import('./internal-migrate')).runInternalMigrate(c),
  update: async (c) => (await import('./update')).runUpdate(c),
  migrate: async (c) => (await import('./migrate')).runMigrate(c),
  adopt: async (c) => (await import('./adopt')).runAdopt(c),
  inspect: async (c) => (await import('./inspect')).runInspect(c),
  upgrade: async (c) => (await import('./upgrade')).runUpgrade(c),
};
