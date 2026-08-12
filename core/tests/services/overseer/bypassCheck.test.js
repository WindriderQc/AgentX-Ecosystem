const fs = require('fs');
const os = require('os');
const path = require('path');
const { isBypassed, BYPASS_MARKER_NAME } = require('../../../src/services/overseer/bypassCheck');

describe('bypassCheck', () => {
  let overseerDir;
  beforeEach(() => {
    overseerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-bypass-'));
  });
  afterEach(() => {
    fs.rmSync(overseerDir, { recursive: true, force: true });
  });

  test('exports marker name', () => {
    expect(BYPASS_MARKER_NAME).toBe('.overseer-bypass');
  });

  test('returns false when marker is absent', () => {
    expect(isBypassed(overseerDir)).toBe(false);
  });

  test('returns true when marker exists', () => {
    fs.writeFileSync(path.join(overseerDir, '.overseer-bypass'), '');
    expect(isBypassed(overseerDir)).toBe(true);
  });

  test('returns false when overseer dir itself does not exist', () => {
    expect(isBypassed(path.join(overseerDir, 'nope'))).toBe(false);
  });
});
