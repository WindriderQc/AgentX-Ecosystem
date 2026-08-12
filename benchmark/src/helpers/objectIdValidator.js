/**
 * ObjectId Validation Helper
 *
 * Prevents NoSQL injection attacks by validating MongoDB ObjectIds
 * before using them in database queries.
 *
 * @module helpers/objectIdValidator
 */

const mongoose = require('mongoose');
const logger = require('../../config/logger');

/**
 * Validate if a string is a valid MongoDB ObjectId
 *
 * @param {string} id - The ID to validate
 * @returns {boolean} - True if valid ObjectId, false otherwise
 */
function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Validate ObjectId and return 400 error if invalid
 *
 * Express middleware-style validator that can be used inline:
 *
 * @example
 * router.get('/api/resource/:id', async (req, res) => {
 *   if (!validateObjectId(req.params.id, res, 'Resource ID')) return;
 *   // Continue with query...
 * });
 *
 * @param {string} id - The ID to validate
 * @param {object} res - Express response object
 * @param {string} fieldName - Human-readable field name for error message
 * @returns {boolean} - True if valid, false if invalid (response already sent)
 */
function validateObjectId(id, res, fieldName = 'ID') {
  if (!isValidObjectId(id)) {
    logger.warn('Invalid ObjectId provided', { id, fieldName });
    res.status(400).json({
      status: 'error',
      message: `Invalid ${fieldName} format`
    });
    return false;
  }
  return true;
}

/**
 * Validate multiple ObjectIds at once
 *
 * @example
 * if (!validateObjectIds(req, res, [
 *   { value: req.params.id, name: 'Resource ID' },
 *   { value: req.body.userId, name: 'User ID' }
 * ])) return;
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {Array<{value: string, name: string}>} ids - Array of IDs to validate
 * @returns {boolean} - True if all valid, false if any invalid
 */
function validateObjectIds(req, res, ids) {
  for (const { value, name } of ids) {
    if (!validateObjectId(value, res, name)) {
      return false;
    }
  }
  return true;
}

/**
 * Express middleware to validate ObjectId in request params
 *
 * @example
 * router.get('/api/resource/:id', validateObjectIdParam('id'), async (req, res) => {
 *   // ID is guaranteed to be valid here
 * });
 *
 * @param {string} paramName - Name of the param to validate (default: 'id')
 * @param {string} fieldName - Human-readable field name for error message
 * @returns {Function} - Express middleware function
 */
function validateObjectIdParam(paramName = 'id', fieldName = 'ID') {
  return (req, res, next) => {
    if (!validateObjectId(req.params[paramName], res, fieldName)) {
      return; // Response already sent
    }
    next();
  };
}

module.exports = {
  isValidObjectId,
  validateObjectId,
  validateObjectIds,
  validateObjectIdParam
};
