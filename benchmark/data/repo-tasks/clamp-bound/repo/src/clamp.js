function clamp(value, lo, hi) {
  return Math.min(lo, Math.min(value, hi));
}
module.exports = clamp;
