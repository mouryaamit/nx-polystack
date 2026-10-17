/* eslint-env browser */
/**
 * @mouryaamit/nx-polystack/runtime/csp-nonce
 *
 * Import first in an Angular app's main.ts:
 *   import '@mouryaamit/nx-polystack/runtime/csp-nonce';
 *
 * Under a strict Content-Security-Policy (script/style elements need a nonce), Angular 15 and
 * webpack add <style>, <script> and <link rel="stylesheet"> elements at runtime without one, so
 * the browser blocks them. This patch gives every such element the page's nonce when it is
 * inserted: Node appendChild/insertBefore/replaceChild (document, elements, shadow roots) and the
 * append/prepend/before/after/insertAdjacentElement methods.
 *
 * The nonce is read from `window.__cspNonce`, else from <meta property="csp-nonce" content="…">
 * (written by the pstack release build) or <meta name="csp-nonce">. A value the server did not
 * fill in (an SSI directive left as is, or a placeholder such as "random-csp-nonce") counts as no
 * nonce: nothing is patched.
 *
 * Plain browser JavaScript with no imports, safe to load more than once.
 */
(function pstackCspNonce() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__pstackCspNoncePatched) return;

  var PLACEHOLDER = /^(random-csp-nonce|nonce|csp-nonce|\{\{.*\}\}|\$\{.*\}|%.*%)$/i;

  function fromMeta() {
    if (typeof document.querySelector !== 'function') return undefined;
    var meta =
      document.querySelector('meta[property="csp-nonce"]') ||
      document.querySelector('meta[name="csp-nonce"]') ||
      document.querySelector('meta[name="CSP-NONCE"]');
    return meta && typeof meta.getAttribute === 'function'
      ? meta.getAttribute('content')
      : undefined;
  }

  /** Anything that looks like a filled-in nonce: no markup, quotes or spaces, not a placeholder. */
  function valid(value) {
    return (
      typeof value === 'string' &&
      value.length >= 8 &&
      !/[\s<>"'`]/.test(value) &&
      !PLACEHOLDER.test(value)
    );
  }

  var raw = window.__cspNonce;
  var nonce = valid(raw) ? raw : undefined;
  if (!nonce) {
    var meta = fromMeta();
    nonce = valid(meta) ? meta : undefined;
  }
  if (!nonce) {
    window.__cspNonce = '';
    return;
  }
  window.__cspNonce = nonce;
  window.__pstackCspNoncePatched = true;

  function needsNonce(node) {
    if (!node || node.nodeType !== 1 || typeof node.getAttribute !== 'function') return false;
    if (node.getAttribute('nonce')) return false;
    var name = String(node.localName || node.nodeName || '').toLowerCase();
    if (name === 'script' || name === 'style') return true;
    return name === 'link' && /(^|\s)stylesheet(\s|$)/i.test(node.getAttribute('rel') || '');
  }

  function stamp(node, depth) {
    if (needsNonce(node)) node.setAttribute('nonce', nonce);
    // A fragment carries its descendants in (walked a few levels deep; elements alone are not
    // walked, so moving a large subtree stays cheap).
    var walk = depth === 0 ? node && node.nodeType === 11 : depth < 8;
    if (walk && node.childNodes) {
      for (var i = 0; i < node.childNodes.length; i++) stamp(node.childNodes[i], depth + 1);
    }
  }

  function wrap(proto, method, nodeArgs) {
    if (!proto || typeof proto[method] !== 'function') return;
    var original = proto[method];
    proto[method] = function () {
      for (var i = 0; i < arguments.length; i++) {
        if (nodeArgs === 'all' || nodeArgs.indexOf(i) !== -1) stamp(arguments[i], 0);
      }
      return original.apply(this, arguments);
    };
  }

  var nodeProto = typeof Node !== 'undefined' ? Node.prototype : undefined;
  wrap(nodeProto, 'appendChild', [0]);
  wrap(nodeProto, 'insertBefore', [0]);
  wrap(nodeProto, 'replaceChild', [0]);

  var parents = [];
  if (typeof Element !== 'undefined') parents.push(Element.prototype);
  if (typeof DocumentFragment !== 'undefined') parents.push(DocumentFragment.prototype);
  if (typeof Document !== 'undefined') parents.push(Document.prototype);
  for (var p = 0; p < parents.length; p++) {
    wrap(parents[p], 'append', 'all');
    wrap(parents[p], 'prepend', 'all');
  }
  if (typeof Element !== 'undefined') {
    wrap(Element.prototype, 'before', 'all');
    wrap(Element.prototype, 'after', 'all');
    wrap(Element.prototype, 'replaceWith', 'all');
    wrap(Element.prototype, 'insertAdjacentElement', [1]);
  }
})();
