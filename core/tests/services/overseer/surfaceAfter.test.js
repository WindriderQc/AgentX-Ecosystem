const { parseSurfaceAfter, isTodoOpenInRoadmap } = require('../../../src/services/overseer/surfaceAfter');

describe('parseSurfaceAfter', () => {
  test('returns null when content is empty', () => {
    expect(parseSurfaceAfter('')).toBeNull();
    expect(parseSurfaceAfter(null)).toBeNull();
    expect(parseSurfaceAfter(undefined)).toBeNull();
  });

  test('returns null when there is no frontmatter block', () => {
    expect(parseSurfaceAfter('# title\n\nbody')).toBeNull();
  });

  test('returns null when frontmatter has no surface_after', () => {
    const md = '---\nfoo: bar\n---\n\n# title';
    expect(parseSurfaceAfter(md)).toBeNull();
  });

  test('parses date-only as midnight UTC', () => {
    const md = '---\nsurface_after: 2026-05-15\n---\n\n# title';
    const d = parseSurfaceAfter(md);
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });

  test('parses RFC3339 timestamp', () => {
    const md = '---\nsurface_after: 2026-05-15T13:30:00Z\n---\n\n# title';
    const d = parseSurfaceAfter(md);
    expect(d.toISOString()).toBe('2026-05-15T13:30:00.000Z');
  });

  test('strips surrounding double quotes', () => {
    const md = '---\nsurface_after: "2026-05-15"\n---\n\n# title';
    const d = parseSurfaceAfter(md);
    expect(d.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });

  test('returns null for malformed values', () => {
    const md = '---\nsurface_after: not-a-date\n---\n\n# title';
    expect(parseSurfaceAfter(md)).toBeNull();
  });

  test('tolerates other frontmatter fields above surface_after', () => {
    const md = '---\ntitle: hi\nsurface_after: 2026-05-15\nowner: yb\n---\nbody';
    const d = parseSurfaceAfter(md);
    expect(d.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });

  test('handles CRLF line endings', () => {
    const md = '---\r\nsurface_after: 2026-05-15\r\n---\r\nbody';
    const d = parseSurfaceAfter(md);
    expect(d.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });
});

describe('isTodoOpenInRoadmap', () => {
  const roadmap = `# Roadmap
- [ ] \`0186\` Soak validation
- [x] \`0184\` Smoke
- [ ] 0190 plain id no backticks
`;

  test('returns true for open backticked id', () => {
    expect(isTodoOpenInRoadmap(roadmap, '0186')).toBe(true);
  });

  test('returns false for closed checkbox', () => {
    expect(isTodoOpenInRoadmap(roadmap, '0184')).toBe(false);
  });

  test('returns true for plain (non-backticked) id', () => {
    expect(isTodoOpenInRoadmap(roadmap, '0190')).toBe(true);
  });

  test('returns false for unknown id', () => {
    expect(isTodoOpenInRoadmap(roadmap, '9999')).toBe(false);
  });

  test('returns false for empty inputs', () => {
    expect(isTodoOpenInRoadmap('', '0186')).toBe(false);
    expect(isTodoOpenInRoadmap(roadmap, '')).toBe(false);
  });
});
