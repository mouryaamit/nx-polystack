(function patchCSPNonce() {
  const nonce = window.__cspNonce;
  if (!nonce) return;
  const origAppend = Element.prototype.appendChild;
  Element.prototype.appendChild = function (node) {
    if (node instanceof HTMLScriptElement) node.setAttribute('nonce', nonce);
    return origAppend.call(this, node);
  };
})();
