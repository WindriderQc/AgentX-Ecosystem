/**
 * Bounded URL context for hand-offs into the RAG document browser.
 *
 * The helper is deliberately dependency-free so upload, search, and documents
 * all agree on the same limits and encoding rules. It is also exported in
 * CommonJS environments for focused contract tests.
 */
(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RAGDocumentContext = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var MAX_CONTEXT_VALUE_LENGTH = 512;
  var CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

  function normalize(value) {
    if (typeof value !== 'string') return '';
    var normalized = value.trim();
    if (!normalized || normalized.length > MAX_CONTEXT_VALUE_LENGTH || CONTROL_CHARACTERS.test(normalized)) {
      return '';
    }
    return normalized;
  }

  function parse(search) {
    var params = new URLSearchParams(typeof search === 'string' ? search : '');
    var hasDocId = params.has('docId');
    var hasSource = params.has('source');
    var docId = normalize(params.get('docId'));
    var source = normalize(params.get('source'));
    var invalidFields = [];

    if (hasDocId && !docId) invalidFields.push('docId');
    if (hasSource && !source) invalidFields.push('source');

    return {
      docId: docId,
      source: source,
      invalid: invalidFields.length > 0,
      invalidFields: invalidFields
    };
  }

  function documentsHref(context) {
    var docId = normalize(context && context.docId);
    var source = normalize(context && context.source);
    var params = [];
    if (docId) params.push('docId=' + encodeURIComponent(docId));
    if (source) params.push('source=' + encodeURIComponent(source));
    return params.length ? '/documents?' + params.join('&') : '/documents';
  }

  function matches(document, context) {
    if (!document || typeof document !== 'object') return false;
    var docId = normalize(context && context.docId);
    var source = normalize(context && context.source);
    if (docId && document.documentId !== docId) return false;
    if (source && document.source !== source) return false;
    return !!(docId || source);
  }

  return Object.freeze({
    MAX_CONTEXT_VALUE_LENGTH: MAX_CONTEXT_VALUE_LENGTH,
    normalize: normalize,
    parse: parse,
    documentsHref: documentsHref,
    matches: matches
  });
});
