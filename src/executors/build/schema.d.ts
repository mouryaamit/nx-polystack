import { NonceSettings } from '../../lib/helpers/inject-nonce';

export interface BuildExecutorSchema {
  type: 'angular' | 'ionic';
  outputPath: string;
  envProject: string;
  /** Pipeline env, set via Nx configurations: DEV, UAT, PROD or a custom one such as QA. */
  env?: string;
  /** Angular build target to run, "<project>:<target>". Default: "<this project>:build". */
  buildTarget?: string;
  /** Configuration of buildTarget. Default: PROD → production, UAT → uat, otherwise development. */
  buildConfiguration?: string;
  /** Write the CSP nonce placeholder into the served index.html (and the other nonce.files). */
  secure?: boolean;
  /** secure: how the nonce placeholder is written (defaults: the standard markup). */
  nonce?: NonceSettings;
  /** Every env: remove HTML comments (not SSI or IE conditionals) from the nonce.files pages. */
  stripHtmlComments?: boolean;
  /** Build meta: `gen: false` leaves out the tool and its versions (gen, ng, nx). */
  buildMeta?: { gen?: boolean };
  /**
   * Integrity for every chunk: passed to the Angular build as --subresource-integrity, hashes
   * refreshed after strip/obfuscate. With cipher aes-gcm the runtime refuses to decrypt when a
   * script has no integrity attribute.
   */
  sri?: boolean;
  /** Replaced by stripComments and dropConsole (read as those when they are unset). */
  harden?: boolean;
  /** non-DEV: plaintext of encrypted env values in the output. */
  leakCheck?: 'fail' | 'warn' | 'off';
  /** non-DEV: .map files or sourceMappingURL comments in the output. */
  sourceMaps?: 'fail' | 'warn' | 'off';
  /** non-DEV: remove comments from the built JS, CSS and served index.html. */
  stripComments?: boolean;
  /** non-DEV: console methods whose calls are removed from the built JS. */
  dropConsole?: ('log' | 'debug' | 'warn' | 'info' | 'error' | 'trace')[];
  /**
   * non-DEV: obfuscate the app's own JS (main and lazy chunks; runtime, polyfills, vendor, scripts
   * and styles are skipped). Needs javascript-obfuscator in the workspace. Default: off.
   */
  obfuscate?: 'off' | 'light' | 'medium' | 'strong';
  /** non-DEV: javascript-obfuscator options on top of the preset (a CSP-safe subset). */
  obfuscateOptions?: Record<string, unknown>;
  /**
   * Copy environments/<envProject>/htaccess.<env> into the served root as .htaccess (default
   * true; the build fails when the file is missing). false: no .htaccess in the output.
   */
  htaccess?: boolean;
  baseHref?: string;
  /** aes-gcm: where the per-build key's shares go. */
  keySplit?: 'meta-bundle' | 'meta-bundle-asset';
  /** aes-gcm: hosts this build may run on (set per configuration). */
  domains?: string[];
  includeWww?: boolean;
  onMismatch?: 'block' | 'warn';
}
