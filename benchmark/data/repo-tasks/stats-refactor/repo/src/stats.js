function average(values) {
  const numbers = values.filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function range(values) {
  if (!values.length) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

module.exports = { average, range };
