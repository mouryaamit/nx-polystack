import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../runtime/csp-style-attr.js'), 'utf8');

/**
 * A small DOM shaped like the real one: setAttribute / setAttributeNS / setAttributeNode live on
 * Element.prototype and write the attribute (which a strict CSP would block for "style"); `style`
 * is a CSSOM declaration whose cssText write the CSP allows. Elements without CSSOM have no style.
 */
function browser() {
  const nativeCalls: string[] = [];
  class CSSStyleDeclaration {
    private text = '';
    get cssText() {
      return this.text;
    }
    set cssText(v: string) {
      this.text = v;
    }
  }
  class Element {
    attrs: Record<string, string> = {};
    style?: CSSStyleDeclaration = new CSSStyleDeclaration();
    setAttribute(n: string, v: string) {
      if (arguments.length < 2) throw new TypeError('2 arguments required');
      nativeCalls.push(`setAttribute:${n}`);
      this.attrs[n] = String(v);
    }
    setAttributeNS(ns: string | null, n: string, v: string) {
      nativeCalls.push(`setAttributeNS:${ns}:${n}`);
      this.attrs[n] = String(v);
    }
    setAttributeNode(a: { name: string; value: string }) {
      nativeCalls.push(`setAttributeNode:${a.name}`);
      this.attrs[a.name] = a.value;
    }
  }
  const originals = {
    setAttribute: Element.prototype.setAttribute,
    setAttributeNS: Element.prototype.setAttributeNS,
    setAttributeNode: Element.prototype.setAttributeNode,
  };
  const window: Record<string, unknown> = {};
  const context = vm.createContext({ window, Element });
  const load = () => vm.runInContext(SOURCE, context);
  load();
  return { Element, nativeCalls, originals, window, load };
}

describe('runtime/csp-style-attr', () => {
  it("routes setAttribute('style', v) to style.cssText, not to the attribute", () => {
    const b = browser();
    const el = new b.Element();
    expect(el.setAttribute('style', 'z-index: 1055; display: block')).toBeUndefined();
    expect(el.style?.cssText).toBe('z-index: 1055; display: block');
    expect(el.attrs['style']).toBeUndefined();
    expect(b.nativeCalls).toEqual([]);
  });

  it('matches the attribute name case-insensitively, like HTML setAttribute', () => {
    const b = browser();
    const el = new b.Element();
    el.setAttribute('STYLE', 'position: absolute');
    expect(el.style?.cssText).toBe('position: absolute');
    expect(b.nativeCalls).toEqual([]);
  });

  it('leaves every other attribute to the original setAttribute', () => {
    const b = browser();
    const el = new b.Element();
    el.setAttribute('onclick', 'alert(1)');
    el.setAttribute('class', 'modal');
    el.setAttribute('nonce', 'abc12345');
    el.setAttribute('data-style', 'x');
    expect(b.nativeCalls).toEqual([
      'setAttribute:onclick',
      'setAttribute:class',
      'setAttribute:nonce',
      'setAttribute:data-style',
    ]);
    expect(el.attrs['onclick']).toBe('alert(1)');
    expect(el.style?.cssText).toBe('');
  });

  it("routes setAttributeNS(null | '', 'style', v); a namespaced style stays native", () => {
    const b = browser();
    const el = new b.Element();
    el.setAttributeNS(null, 'style', 'fill: red');
    expect(el.style?.cssText).toBe('fill: red');
    el.setAttributeNS('', 'style', 'fill: blue');
    expect(el.style?.cssText).toBe('fill: blue');
    el.setAttributeNS('urn:x', 'style', 'other');
    el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#icon');
    expect(b.nativeCalls).toEqual([
      'setAttributeNS:urn:x:style',
      'setAttributeNS:http://www.w3.org/1999/xlink:xlink:href',
    ]);
  });

  it('passes the value through String(), as the attribute would', () => {
    const b = browser();
    const el = new b.Element();
    el.setAttribute('style', 42 as unknown as string);
    expect(el.style?.cssText).toBe('42');
  });

  it('falls back to the original for an element without CSSOM style', () => {
    const b = browser();
    const el = new b.Element();
    el.style = undefined;
    el.setAttribute('style', 'color: red');
    expect(b.nativeCalls).toEqual(['setAttribute:style']);
    expect(el.attrs['style']).toBe('color: red');
  });

  it('keeps the original error for a call with one argument', () => {
    const b = browser();
    const el = new b.Element();
    expect(() => (el.setAttribute as (n: string) => void)('style')).toThrow(TypeError);
  });

  it('does not patch setAttributeNode (F3: it stays blocked by style-src-attr)', () => {
    const b = browser();
    expect(b.Element.prototype.setAttributeNode).toBe(b.originals.setAttributeNode);
    expect(b.Element.prototype.setAttribute).not.toBe(b.originals.setAttribute);
    expect(b.Element.prototype.setAttributeNS).not.toBe(b.originals.setAttributeNS);
  });

  it('patches once when loaded twice', () => {
    const b = browser();
    const patched = b.Element.prototype.setAttribute;
    b.load();
    expect(b.Element.prototype.setAttribute).toBe(patched);
    expect(b.window['__pstackCspStyleAttrPatched']).toBe(true);
  });
});
