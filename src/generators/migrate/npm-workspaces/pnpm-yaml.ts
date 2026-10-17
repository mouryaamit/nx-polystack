/**
 * A reader for the YAML that pnpm-workspace.yaml uses: block mappings, block sequences, flow
 * sequences and maps of plain or quoted scalars, and comments. Not a general YAML parser: anchors,
 * aliases, tags, block scalars (`|`, `>`) and multi-document files are refused with an error.
 */

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
  no: number;
}

const fail = (no: number, why: string): never => {
  throw new Error(`line ${no}: ${why}`);
};

/** A quote at `i` opens a quoted scalar only where a scalar starts (not inside "don't"). */
function opensQuote(text: string, i: number): boolean {
  const c = text[i];
  if (c !== '"' && c !== "'") return false;
  const before = text.slice(0, i);
  const trimmed = before.trimEnd();
  if (trimmed === '' || /[[{,]$/.test(trimmed)) return true;
  // "- 'x'" (a list marker, not "pre-'x'") and "key: 'x'" (": " or ":" at the end).
  if (/^\s*-$/.test(trimmed) && before !== trimmed) return true;
  return /:\s+$/.test(before);
}

/**
 * Walks `text` outside quoted scalars, calling `visit(i)` for each character there; stops when
 * `visit` returns true and gives that index (-1 when it never does).
 */
function scanOutsideQuotes(text: string, visit: (i: number) => boolean): number {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = undefined;
    } else if (quote === "'") {
      if (c === "'" && text[i + 1] === "'") i++;
      else if (c === "'") quote = undefined;
    } else if (opensQuote(text, i)) quote = c;
    else if (visit(i)) return i;
  }
  return -1;
}

/** Strips a comment: "#" at the start or after whitespace, outside quotes. */
function stripComment(line: string): string {
  const at = scanOutsideQuotes(line, (i) => line[i] === '#' && (i === 0 || /\s/.test(line[i - 1])));
  return at < 0 ? line : line.slice(0, at);
}

function scalar(raw: string, no: number): string {
  const t = raw.trim();
  if (/^".*"$/.test(t)) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return fail(no, `bad quoted string ${t}`);
    }
  }
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^["']/.test(t)) return fail(no, `unterminated quoted string ${t}`);
  if (t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return '';
  if (/^[&*!|>]/.test(t)) {
    return fail(no, `"${t[0]}" (anchors, aliases, tags, block scalars) is not supported`);
  }
  return t;
}

/** Splits a flow collection's body at top-level commas. */
function splitFlow(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  scanOutsideQuotes(body, (i) => {
    const c = body[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
    return false;
  });
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** Index of the ": " (or trailing ":") that ends a mapping key, outside quotes; -1 when none. */
function keyEnd(text: string): number {
  // Only a quote at the very start makes a quoted key; "a: 'b: c'" ends at the first ": ".
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"' && c === '\\') i++;
    else if (quote) {
      if (c === quote) quote = undefined;
    } else if ((c === '"' || c === "'") && i === 0) quote = c;
    else if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function inline(raw: string, no: number): YamlValue {
  const t = raw.trim();
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) fail(no, 'unclosed "["');
    return splitFlow(t.slice(1, -1)).map((s) => inline(s, no));
  }
  if (t.startsWith('{')) {
    if (!t.endsWith('}')) fail(no, 'unclosed "{"');
    const out: Record<string, YamlValue> = {};
    for (const part of splitFlow(t.slice(1, -1))) {
      const at = keyEnd(part);
      if (at < 0) fail(no, `"${part}" is not a key: value pair`);
      out[scalar(part.slice(0, at), no)] = inline(part.slice(at + 1), no);
    }
    return out;
  }
  return scalar(t, no);
}

function block(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const first = lines[start];
  if (first.text.startsWith('- ') || first.text === '-') {
    const list: YamlValue[] = [];
    let i = start;
    while (i < lines.length && lines[i].indent === indent && /^-( |$)/.test(lines[i].text)) {
      const item = lines[i].text.slice(1).trim();
      if (item === '') {
        if (i + 1 < lines.length && lines[i + 1].indent > indent) {
          const [v, next] = block(lines, i + 1, lines[i + 1].indent);
          list.push(v);
          i = next;
          continue;
        }
        list.push('');
        i++;
        continue;
      }
      if (keyEnd(item) >= 0 && !/^["'[{]/.test(item)) {
        // "- key: value" starts a mapping item; its other keys are indented under the key.
        const itemIndent = indent + (lines[i].text.length - item.length);
        const sub: Line[] = [{ indent: itemIndent, text: item, no: lines[i].no }];
        let j = i + 1;
        while (j < lines.length && lines[j].indent > indent) sub.push(lines[j++]);
        list.push(block(sub, 0, itemIndent)[0]);
        i = j;
        continue;
      }
      list.push(inline(item, lines[i].no));
      i++;
    }
    return [list, i];
  }
  const map: Record<string, YamlValue> = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const { text, no } = lines[i];
    if (/^-( |$)/.test(text)) fail(no, 'a list item where a key was expected');
    const at = keyEnd(text);
    if (at < 0) fail(no, `"${text}" is not a key: value pair`);
    const key = scalar(text.slice(0, at), no);
    const rest = text.slice(at + 1).trim();
    i++;
    if (rest !== '') {
      map[key] = inline(rest, no);
    } else if (i < lines.length && lines[i].indent > indent) {
      const [v, next] = block(lines, i, lines[i].indent);
      map[key] = v;
      i = next;
    } else if (i < lines.length && lines[i].indent === indent && /^-( |$)/.test(lines[i].text)) {
      // A list at the key's own indent ("packages:\n- a").
      const [v, next] = block(lines, i, indent);
      map[key] = v;
      i = next;
    } else {
      map[key] = '';
    }
  }
  if (i < lines.length && lines[i].indent > indent) fail(lines[i].no, 'unexpected indentation');
  return [map, i];
}

/** Parses the text; throws "line N: …" on what it cannot read. */
export function parsePnpmYaml(text: string): Record<string, YamlValue> {
  const lines: Line[] = [];
  let ended = false;
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((raw, idx) => {
      const no = idx + 1;
      if (/^\.\.\.\s*$/.test(raw)) {
        ended = true;
        return;
      }
      if (/^---\s*$/.test(raw)) {
        if (lines.length > 0 || ended) fail(no, 'more than one YAML document');
        return;
      }
      if (ended && stripComment(raw).trim() !== '') fail(no, 'more than one YAML document');
      if (/^\s*\t/.test(raw)) fail(no, 'tab indentation');
      const line = stripComment(raw).replace(/\s+$/, '');
      if (line.trim() === '') return;
      lines.push({ indent: line.length - line.trimStart().length, text: line.trim(), no });
    });
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) fail(lines[0].no, 'the file must start at column 0');
  const [value, next] = block(lines, 0, 0);
  if (next < lines.length) fail(lines[next].no, 'unexpected content');
  if (Array.isArray(value) || typeof value === 'string') fail(lines[0].no, 'expected keys');
  return value as Record<string, YamlValue>;
}
