'use strict';

const { createObjectIdValidator } = require('../../../shared/objectIdValidator');

module.exports = createObjectIdValidator({
  mongoose: require('mongoose'),
  logger: require('../../config/logger')
});
