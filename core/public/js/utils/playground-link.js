(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentXPlaygroundLink = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function buildPlaygroundHref(model, host) {
    var params = new URLSearchParams();
    var modelName = String(model || '').trim();
    var hostUrl = String(host || '').trim();
    if (modelName) params.set('model', modelName);
    if (hostUrl) params.set('host', hostUrl);
    var query = params.toString();
    return '/playground' + (query ? '?' + query : '');
  }

  return { buildPlaygroundHref: buildPlaygroundHref };
});
