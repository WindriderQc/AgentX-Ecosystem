function parseScores(csv) {
  return String(csv).split('\n').map((line) => {
    const [name, score] = line.split(',');
    return { name, score: Number(score) };
  });
}
module.exports = parseScores;
