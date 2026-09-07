'use strict';
// Test infrastructure must not inherit the service .env or its Mongo target.
process.env.NODE_ENV = 'test';
process.env.MONGOMS_VERSION ||= '7.0.24';
if (process.env.TEST_USE_EXTERNAL_MONGO === 'true') {
  if (!process.env.MONGODB_URI_TEST) throw new Error('External tests require MONGODB_URI_TEST explicitly');
} else {
  delete process.env.MONGODB_URI;
  delete process.env.MONGODB_URI_TEST;
}
