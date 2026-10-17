/** Build info written into the meta tag by the release build. */
export interface BuildMeta {
  env?: string;
  branch?: string;
  commit?: string;
  build?: string;
  [key: string]: unknown;
}

export interface EnvReadyOptions {
  /** Decrypt every encrypted value of the environment (nested too) in place. */
  inPlace?: boolean;
  /** Top-level fields (or 'all') decrypted at startup into a private cache for envSecret(). */
  sync?: string[] | 'all';
  /** Meta tag with the build info (default x-build; the same environment object keeps its name). */
  metaName?: string;
  /**
   * Key source custom (aes-gcm, envReady only): returns the custom key factor, e.g. fetched from
   * your server. Required when the build lists custom in keySources.
   */
  getKey?: () => string | Promise<string>;
}

/** The build info from the meta tag (without the aes-gcm key share), or null (dev server, tests). */
export function getBuildMeta(metaName?: string): BuildMeta | null;

/** True for ENC(...) and ENC2(...) values and bare CryptoJS passphrase ciphertext. */
export function isEncryptedValue(value: unknown): value is string;

/** Plaintext of an encrypted value, or the value unchanged (always for aes-gcm ENC2 values). */
export function decryptEnvValue(value: string, commit?: string | null): string;

/** Decrypts every encrypted value of any object tree in place (not registered); returns the paths. */
export function decryptTree(obj: object, commit?: string | null): string[];

/**
 * Decrypts every encrypted value (aes-gcm ENC2 and CryptoJS) of any object tree in place with the
 * key registered by envReady; returns the paths. Rejects before envReady or when the domain lock
 * refused this host.
 */
export function decryptTreeAsync(obj: object): Promise<string[]>;

/**
 * Registers and prepares the environment object; returns the dotted paths decrypted. Leaves
 * aes-gcm ENC2(...) values alone: use envReady.
 */
export function envReadySync(environment: object, options?: EnvReadyOptions): string[];

/**
 * envReadySync as a Promise; also decrypts aes-gcm ENC2(...) values (Web Crypto), so aes-gcm apps
 * must await it in main.ts before bootstrap. Applies the build's domain lock. Values that fail
 * authentication stay encrypted and are reported by path.
 */
export function envReady(environment: object, options?: EnvReadyOptions): Promise<string[]>;

/** Plaintext of a top-level env field ('' when it is not a string); cached. Throws on an ENC2 value. */
export function envSecret(key: string): string;

/** Plaintext of a top-level env field, decrypted on every call; nothing is kept. */
export function envSecretAsync(key: string): Promise<string>;

/** True when `host` is listed (`*.x` = any subdomain of x; `x` also allows www.x when www). */
export function isHostAllowed(host: string, hosts: string[], www: boolean): boolean;
