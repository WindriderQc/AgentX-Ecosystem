'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

describe('legacy Chat page redirect', () => {
  test('preserves the exact model, host, persona, and prompt version query', async () => {
    const response = await request(app)
      .get('/chat?model=org%2Fmodel%3Alatest&host=http%3A%2F%2Fhost-a%3A11434&persona=reviewer&promptVersion=4')
      .expect(301);

    expect(response.headers.location).toBe(
      '/playground?model=org%2Fmodel%3Alatest&host=http%3A%2F%2Fhost-a%3A11434&persona=reviewer&promptVersion=4'
    );
  });
});
