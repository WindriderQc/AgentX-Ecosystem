'use strict';

const context = require('../../public/js/document-context');

describe('bounded document journey context', () => {
  test('round-trips exact document and source context with URL-safe encoding', () => {
    const href = context.documentsHref({
      docId: 'guide/v2 #final',
      source: 'Product guides & policies',
    });

    expect(href).toBe('/documents?docId=guide%2Fv2%20%23final&source=Product%20guides%20%26%20policies');
    expect(context.parse(href.slice(href.indexOf('?')))).toEqual({
      docId: 'guide/v2 #final',
      source: 'Product guides & policies',
      invalid: false,
      invalidFields: [],
    });
  });

  test('accepts the documented bound and rejects oversized or control-character context', () => {
    const atBound = 'x'.repeat(context.MAX_CONTEXT_VALUE_LENGTH);
    const overBound = 'x'.repeat(context.MAX_CONTEXT_VALUE_LENGTH + 1);

    expect(context.normalize(atBound)).toBe(atBound);
    expect(context.parse('?docId=' + overBound)).toMatchObject({
      docId: '',
      invalid: true,
      invalidFields: ['docId'],
    });
    expect(context.parse('?source=guide%00name')).toMatchObject({
      source: '',
      invalid: true,
      invalidFields: ['source'],
    });
    expect(context.documentsHref({ docId: overBound, source: 'valid' })).toBe('/documents?source=valid');
  });

  test('requires exact document identity and provenance when both are supplied', () => {
    const requested = { docId: 'doc-42', source: 'runbook.md' };

    expect(context.matches({ documentId: 'doc-42', source: 'runbook.md' }, requested)).toBe(true);
    expect(context.matches({ documentId: 'doc-420', source: 'runbook.md' }, requested)).toBe(false);
    expect(context.matches({ documentId: 'doc-42', source: 'other.md' }, requested)).toBe(false);
    expect(context.matches({ documentId: 'doc-42', source: 'runbook.md' }, {})).toBe(false);
  });
});
