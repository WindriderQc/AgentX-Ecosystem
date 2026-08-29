'use strict';

function describeRequestFailure(request) {
  return {
    url: request.url(),
    resourceType: request.resourceType(),
    failureReason: request.failure()?.errorText || 'request failed without an error reason',
  };
}

module.exports = { describeRequestFailure };
