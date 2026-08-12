const { hashText, textRecord } = require('../../src/services/voicePersonaAuditService');

describe('voicePersonaAuditService', () => {
  test('stores hash and preview when raw transcript retention is disabled', () => {
    const record = textRecord('  hello   world  ', {
      rawTranscriptRetention: 'disabled',
      previewChars: 8
    });

    expect(record.length).toBe(11);
    expect(record.sha256).toBe(hashText('hello world'));
    expect(record.preview).toBe('hello wo');
    expect(record.text).toBeUndefined();
  });

  test('stores raw text only when explicitly enabled', () => {
    const record = textRecord('secret-free text', {
      rawTranscriptRetention: 'enabled'
    });

    expect(record.text).toBe('secret-free text');
    expect(record.preview).toBeUndefined();
  });
});
