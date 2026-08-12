async function retry(operation, maxAttempts = 3) {
  return operation();
}
module.exports = retry;
