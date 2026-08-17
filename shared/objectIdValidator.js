'use strict';

function createObjectIdValidator({ mongoose, logger }) {
  function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
  }

  function validateObjectId(id, res, fieldName = 'ID') {
    if (isValidObjectId(id)) return true;
    logger?.warn?.('Invalid ObjectId provided', { id, fieldName });
    res.status(400).json({ status: 'error', message: `Invalid ${fieldName} format` });
    return false;
  }

  function validateObjectIds(_req, res, ids) {
    return ids.every(({ value, name }) => validateObjectId(value, res, name));
  }

  function validateObjectIdParam(paramName = 'id', fieldName = 'ID') {
    return (req, res, next) => {
      if (validateObjectId(req.params[paramName], res, fieldName)) next();
    };
  }

  return { isValidObjectId, validateObjectId, validateObjectIds, validateObjectIdParam };
}

module.exports = { createObjectIdValidator };
