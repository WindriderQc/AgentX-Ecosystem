'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

describe('Core page routes', () => {
  test.each(['/alerts', '/dashboard', '/hosts', '/demo', '/portal/index.html', '/chat', '/nestor', '/roundtable'])(
    '%s is retired without a redirect', async (url) => {
      const response = await request(app).get(`${url}?question=Compare%20these`).expect(404);
      expect(response.headers.location).toBeUndefined();
    }
  );

  test.each(['/', '/portal/', '/playground?model=org%2Fmodel%3Alatest&persona=reviewer&promptVersion=4', '/council'])(
    '%s renders directly', async (url) => {
      const response = await request(app).get(url).expect(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['content-type']).toMatch(/text\/html/);
    }
  );
});
