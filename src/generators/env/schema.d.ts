export interface EnvGeneratorSchema {
  /** New environment name (lowercase kebab-case, e.g. qa, sit, staging). */
  name: string;
  /** Apps to add it to (project names). Either this or `all`. */
  projects?: string[];
  /** Add it to every app with environments. */
  all?: boolean;
  /** Existing environment the new one is copied from (default: uat, else prod). */
  from?: string;
  /** API base URL for the new environment (fields whose key mentions "api"). */
  apiUrl?: string;
  /** Set `production: true|false` in the new Angular env file (default: as in --from). */
  production?: boolean;
  /** Base href of the new release / Flutter build-web configuration (default: as in --from). */
  baseHref?: string;
  /** Hosts the new aes-gcm release configuration may run on (default: none). */
  domains?: string[];
}
