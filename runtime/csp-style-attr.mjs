/* eslint-env browser */
/**
 * @mouryaamit/nx-polystack/runtime/csp-style-attr (opt-in)
 *
 * Import right after runtime/csp-nonce in main.ts:
 *   import '@mouryaamit/nx-polystack/runtime/csp-nonce';
 *   import '@mouryaamit/nx-polystack/runtime/csp-style-attr';
 *
 * Under style-src without 'unsafe-inline', element.setAttribute('style', v) is blocked
 * (style-src-attr), but the same declarations written through the CSSOM (style.cssText = v) are
 * allowed. Angular writes static template / host style attributes with setAttribute('style'), so
 * this routes setAttribute('style', v) and setAttributeNS(null, 'style', v) to style.cssText.
 * Nothing else changes: other attributes, setAttributeNode, attributes.setNamedItem, Attr.value
 * and style attributes parsed by the HTML parser (innerHTML, insertAdjacentHTML, static
 * index.html markup) stay blocked. Static style="" in Angular templates is covered: Angular
 * writes it with setAttribute.
 * getAttribute('style') then returns the browser's normalised text, without declarations it does
 * not support. Never pass user-controlled data to these writes. Rollback: remove the import.
 *
 * Plain browser JavaScript with no imports, safe to load more than once.
 */
(function pstackCspStyleAttr() {
  if (typeof window === 'undefined' || typeof Element === 'undefined') return;
  if (window.__pstackCspStyleAttrPatched) return;
  window.__pstackCspStyleAttrPatched = true;

  var proto = Element.prototype;
  var setAttribute = proto.setAttribute;
  var setAttributeNS = proto.setAttributeNS;

  /** The element's CSSOM declaration when name is the style attribute, else undefined. */
  function styleOf(el, name) {
    if (typeof name !== 'string' || name.toLowerCase() !== 'style') return undefined;
    var style = el.style;
    return style && typeof style === 'object' && 'cssText' in style ? style : undefined;
  }

  proto.setAttribute = function (name, value) {
    var style = arguments.length >= 2 ? styleOf(this, name) : undefined;
    if (!style) return setAttribute.apply(this, arguments);
    style.cssText = String(value);
  };

  if (typeof setAttributeNS === 'function') {
    proto.setAttributeNS = function (ns, name, value) {
      var style = arguments.length >= 3 && !ns ? styleOf(this, name) : undefined;
      if (!style) return setAttributeNS.apply(this, arguments);
      style.cssText = String(value);
    };
  }
})();
