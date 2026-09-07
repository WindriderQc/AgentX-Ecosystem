'use strict';
const mongoose = require('mongoose');
const { suiteDatabase } = require('../../../shared/testing/mongoIdentity');
module.exports = () => {
  test('owns a fresh database for this run and file', async () => {
    expect(mongoose.connection.name).toBe(suiteDatabase(expect.getState().testPath));
    const collection = mongoose.connection.collection('test_harness_isolation');
    expect(await collection.countDocuments({})).toBe(0);
    await collection.insertOne({ marker: 'must not reach another test file' });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await collection.countDocuments({})).toBe(1);
  });
};
