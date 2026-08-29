'use strict';

const { buildPlaygroundHref } = require('../../public/js/utils/playground-link');

describe('Playground model handoff link', () => {
  test('preserves and encodes the exact runtime pair', () => {
    expect(buildPlaygroundHref('org/model:latest', 'http://host-a:11434/')).toBe(
      '/playground?model=org%2Fmodel%3Alatest&host=http%3A%2F%2Fhost-a%3A11434%2F'
    );
  });

  test('does not invent an omitted model or host', () => {
    expect(buildPlaygroundHref('', '')).toBe('/playground');
    expect(buildPlaygroundHref('model one', '')).toBe('/playground?model=model+one');
  });
});
