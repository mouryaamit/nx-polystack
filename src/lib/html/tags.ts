/**
 * A small HTML start-tag scanner for the build's index.html rewrites (nonce, SRI).
 *
 * - A quoted attribute value ends at its own closing quote; an SSI directive (`<!--#…-->`) inside
 *   it is skipped whole, so `nonce="<!--#echo var="X" -->"` is one value.
 * - Comments are skipped; the content of <script>/<style> (raw text) is not scanned for tags.
 * - Offsets let callers insert text without rebuilding (and so without reformatting) a tag.
 */

export interface HtmlAttribute {
  /** Lower-case name. */
  name: string;
  /** Value without quotes (raw, entities not decoded); undefined for a bare attribute. */
  value?: string;
  /** Offset of the attribute name. */
  start: number;
  /** Offset just after the attribute (after the closing quote of its value). */
  end: number;
}

export interface HtmlTag {
  /** Lower-case tag name. */
  name: string;
  /** Offset of `<`. */
  start: number;
  /** Offset just after `>`. */
  end: number;
  /** Offset just after the tag name. */
  nameEnd: number;
  /** Offset after the last attribute (or the name), before any whitespace, `/` and `>`. */
  attrsEnd: number;
  attrs: HtmlAttribute[];
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const SSI_OPEN = '<!--#';

/** Index just after the SSI directive starting at i; an unclosed one is plain text. */
function skipSsi(html: string, i: number): number {
  const close = html.indexOf('-->', i + SSI_OPEN.length);
  return close < 0 ? i + SSI_OPEN.length : close + 3;
}

const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** Parses the start tag at `start` (html[start] === '<', a letter follows); undefined if unterminated. */
function parseTag(html: string, start: number): HtmlTag | undefined {
  let i = start + 1;
  while (i < html.length && /[A-Za-z0-9:-]/.test(html[i])) i++;
  const name = html.slice(start + 1, i).toLowerCase();
  const nameEnd = i;
  let attrsEnd = nameEnd;
  const attrs: HtmlAttribute[] = [];
  while (i < html.length) {
    while (isSpace(html[i])) i++;
    const c = html[i];
    if (c === undefined) return undefined;
    if (c === '>') {
      return { name, start, end: i + 1, nameEnd, attrsEnd, attrs };
    }
    if (c === '/' && html[i + 1] === '>') {
      return { name, start, end: i + 2, nameEnd, attrsEnd, attrs };
    }
    if (c === '/') {
      i++;
      continue;
    }
    if (html.startsWith(SSI_OPEN, i)) {
      // A directive standing in an attribute position (rare): keep it as a bare "attribute".
      const end = skipSsi(html, i);
      attrs.push({ name: html.slice(i, end), start: i, end });
      attrsEnd = end;
      i = end;
      continue;
    }
    const attrStart = i;
    while (i < html.length && !isSpace(html[i]) && !'=>'.includes(html[i]) && html[i] !== '/') i++;
    if (i === attrStart) i++; // a stray character: move on
    const attrName = html.slice(attrStart, i).toLowerCase();
    let j = i;
    while (isSpace(html[j])) j++;
    if (html[j] !== '=') {
      attrs.push({ name: attrName, start: attrStart, end: i });
      attrsEnd = i;
      continue;
    }
    j++;
    while (isSpace(html[j])) j++;
    const q = html[j];
    let value: string;
    if (q === '"' || q === "'") {
      let k = j + 1;
      while (k < html.length && html[k] !== q) {
        k = html.startsWith(SSI_OPEN, k) ? skipSsi(html, k) : k + 1;
      }
      if (k >= html.length) return undefined;
      value = html.slice(j + 1, k);
      i = k + 1;
    } else {
      let k = j;
      while (k < html.length && !isSpace(html[k]) && html[k] !== '>') {
        k = html.startsWith(SSI_OPEN, k) ? skipSsi(html, k) : k + 1;
      }
      value = html.slice(j, k);
      i = k;
    }
    attrs.push({ name: attrName, value, start: attrStart, end: i });
    attrsEnd = i;
  }
  return undefined;
}

/** Offset of the `</name` that closes a raw-text element (followed by space, / or >). */
function rawTextEnd(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : html.length;
}

/** Plain comments outside tags and raw text; SSI (`<!--#`) and IE conditionals stay. */
export function stripHtmlCommentsSafe(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      const end = close < 0 ? html.length : close + 3;
      const keep = /^<!--(?:#|\[if|<!\[endif)/.test(html.slice(lt, lt + 12));
      out += html.slice(i, keep ? end : lt);
      i = end;
      continue;
    }
    const tag = /[A-Za-z]/.test(html[lt + 1] ?? '') ? parseTag(html, lt) : undefined;
    if (!tag) {
      out += html.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    const end = RAW_TEXT.has(tag.name) ? rawTextEnd(html, tag.name, tag.end) : tag.end;
    out += html.slice(i, end);
    i = end;
  }
  return out + html.slice(i);
}

/** Every start tag in document order. */
export function scanTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (!/[A-Za-z]/.test(html[lt + 1] ?? '')) {
      i = lt + 1;
      continue;
    }
    const tag = parseTag(html, lt);
    if (!tag) {
      // Unterminated: skip this "<" and keep scanning rather than drop the rest of the page.
      i = lt + 1;
      continue;
    }
    tags.push(tag);
    i = tag.end;
    if (RAW_TEXT.has(tag.name)) i = rawTextEnd(html, tag.name, i);
  }
  return tags;
}

export const attr = (tag: HtmlTag, name: string): HtmlAttribute | undefined =>
  tag.attrs.find((a) => a.name === name);

export interface Insertion {
  at: number;
  text: string;
}

/** html with every insertion applied (offsets refer to the original text). */
export function applyInsertions(html: string, insertions: Insertion[]): string {
  let out = html;
  for (const ins of [...insertions].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  }
  return out;
}
