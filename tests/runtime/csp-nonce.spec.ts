import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../runtime/csp-nonce.js'), 'utf8');

/**
 * A small DOM shaped like the real one: insertion methods live on Node.prototype (appendChild,
 * insertBefore, replaceChild) and on Element/DocumentFragment (append, prepend, …); shadow
 * roots are document fragments; element kinds are told apart by localName.
 */
function browser(opts: { cspNonce?: string; meta?: Record<string, string> } = {}) {
  class Node {
    nodeType = 1;
    childNodes: Node[] = [];
    appendChild(n: Node) {
      this.childNodes.push(n);
      return n;
    }
    insertBefore(n: Node, ref: Node | null) {
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
      return n;
    }
    replaceChild(n: Node, old: Node) {
      this.childNodes[this.childNodes.indexOf(old)] = n;
      return old;
    }
  }
  class Element extends Node {
    attrs: Record<string, string> = {};
    constructor(public localName = 'div') {
      super();
    }
    getAttribute(n: string) {
      return this.attrs[n] ?? null;
    }
    setAttribute(n: string, v: string) {
      this.attrs[n] = v;
    }
    append(...nodes: Node[]) {
      this.childNodes.push(...nodes);
    }
    prepend(...nodes: Node[]) {
      this.childNodes.unshift(...nodes);
    }
    insertAdjacentElement(_where: string, el: Element) {
      this.childNodes.push(el);
      return el;
    }
    attachShadow() {
      return new ShadowRoot();
    }
  }
  class DocumentFragment extends Node {
    nodeType = 11;
    append(...nodes: Node[]) {
      this.childNodes.push(...nodes);
    }
  }
  class ShadowRoot extends DocumentFragment {}
  const metas = Object.entries(opts.meta ?? {}).map(([selector, content]) => {
    const m = new Element('meta');
    m.setAttribute('content', content);
    return { selector, m };
  });
  const head = new Element('head');
  const document = {
    head,
    querySelector: (sel: string) => metas.find((x) => x.selector === sel)?.m ?? null,
  };
  const window: Record<string, unknown> = {};
  if (opts.cspNonce !== undefined) window['__cspNonce'] = opts.cspNonce;
  vm.runInContext(SOURCE, vm.createContext({ window, document, Node, Element, DocumentFragment }));
  const el = (name: string, attrs: Record<string, string> = {}) => {
    const e = new Element(name);
    Object.assign(e.attrs, attrs);
    return e;
  };
  return { window, head, el, DocumentFragment };
}

const NONCE = 'Abc123XyZ987==';

describe('runtime/csp-nonce', () => {
  it('stamps scripts, styles and stylesheet links appended to document.head', () => {
    const b = browser({ cspNonce: NONCE });
    const script = b.el('script');
    const style = b.el('style');
    const link = b.el('link', { rel: 'stylesheet' });
    const icon = b.el('link', { rel: 'icon' });
    const div = b.el('div');
    b.head.appendChild(script);
    b.head.insertBefore(style, null);
    b.head.append(link, icon, div);
    expect(script.getAttribute('nonce')).toBe(NONCE);
    expect(style.getAttribute('nonce')).toBe(NONCE);
    expect(link.getAttribute('nonce')).toBe(NONCE);
    expect(icon.getAttribute('nonce')).toBeNull();
    expect(div.getAttribute('nonce')).toBeNull();
    expect(b.head.childNodes).toHaveLength(5);
  });

  it('covers shadow roots, fragments and the other insertion methods', () => {
    const b = browser({ cspNonce: NONCE });
    const host = b.el('my-cmp');
    const shadow = host.attachShadow();
    const shadowStyle = b.el('STYLE');
    shadow.appendChild(shadowStyle);
    const frag = new b.DocumentFragment();
    const fragScript = b.el('script');
    const wrapper = b.el('div');
    const deepStyle = b.el('style');
    wrapper.childNodes.push(deepStyle);
    frag.childNodes.push(fragScript, wrapper);
    b.head.appendChild(frag);
    const adjacent = b.el('style');
    host.insertAdjacentElement('beforeend', adjacent);
    const replaced = b.el('script');
    const old = b.el('div');
    b.head.appendChild(old);
    b.head.replaceChild(replaced, old);
    for (const e of [shadowStyle, fragScript, deepStyle, adjacent, replaced]) {
      expect(e.getAttribute('nonce')).toBe(NONCE);
    }
  });

  it('keeps a nonce an element already has', () => {
    const b = browser({ cspNonce: NONCE });
    const script = b.el('script', { nonce: 'own-nonce-1' });
    b.head.appendChild(script);
    expect(script.getAttribute('nonce')).toBe('own-nonce-1');
  });

  it('reads the csp-nonce meta tag when the global is an unprocessed placeholder', () => {
    const b = browser({
      cspNonce: 'random-csp-nonce',
      meta: { 'meta[property="csp-nonce"]': 'MetaNonce1234' },
    });
    const style = b.el('style');
    b.head.appendChild(style);
    expect(style.getAttribute('nonce')).toBe('MetaNonce1234');
    expect(b.window['__cspNonce']).toBe('MetaNonce1234');
  });

  it('accepts other nonce formats (e.g. an Apache UNIQUE_ID with @ and -)', () => {
    const b = browser({ cspNonce: 'Zx9@k-Q1:wY.7' });
    const style = b.el('style');
    b.head.appendChild(style);
    expect(style.getAttribute('nonce')).toBe('Zx9@k-Q1:wY.7');
  });

  it('patches nothing without a real nonce (SSI not processed)', () => {
    const b = browser({ meta: { 'meta[property="csp-nonce"]': '<!--#echo var="UNIQUE_ID"-->' } });
    const script = b.el('script');
    b.head.appendChild(script);
    expect(script.getAttribute('nonce')).toBeNull();
    expect(b.window['__cspNonce']).toBe('');
  });
});
