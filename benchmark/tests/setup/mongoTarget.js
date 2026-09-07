'use strict';
const { suiteDatabase, withDatabase } = require('../../../shared/testing/mongoIdentity');
if (process.env.TEST_USE_EXTERNAL_MONGO === 'true') {
  process.env.MONGODB_URI_TEST = withDatabase(process.env.MONGODB_URI_TEST, suiteDatabase(expect.getState().testPath));
}
