const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * A host for the domain lock: lowercase, punycode, no scheme/port/path/trailing dot; `*.` prefix
 * kept for "any subdomain". Undefined when it is not a host name. Userinfo (`@`), backslashes and
 * percent-escapes are refused; a path, query or fragment only with an explicit scheme (a pasted URL). A wildcard
 * needs a base with at least two labels and is not allowed on an IPv4 address.
 */
export function normalizeHost(input: string): string | undefined {
  let s = input.trim();
  if (!s) return undefined;
  const wildcard = s.startsWith('*.');
  if (wildcard) s = s.slice(2);
  if (/[*@\\%]/.test(s)) return undefined;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hasScheme && /[/?#]/.test(s)) return undefined;
  let host: string;
  try {
    host = new URL(hasScheme ? s : `http://${s}`).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/\.$/, '');
  if (!host || !host.split('.').every((l) => LABEL.test(l))) return undefined;
  if (wildcard && (!host.includes('.') || IPV4.test(host))) return undefined;
  return wildcard ? `*.${host}` : host;
}

/** Normalised, de-duplicated hosts; throws naming the first entry that is not a host. */
export function normalizeHosts(list: string[]): string[] {
  const out: string[] = [];
  for (const entry of list) {
    const h = normalizeHost(entry);
    if (!h) throw new Error(`env encryption: domain "${entry}" is not a host name.`);
    if (!out.includes(h)) out.push(h);
  }
  return out;
}
