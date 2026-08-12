const parseScores = require('../src/parseScores');
const rows = parseScores('\nZero,0\nPerfect,100\n');
if (rows.length !== 2 || rows[0].score !== 0 || rows[1].score !== 100) process.exit(1);
for (const [input, row] of [['NoScore,', 1], ['A,20,extra', 1], ['Ok,2\nBad,nope', 2], [',50', 1]]) {
  try { parseScores(input); process.exit(1); } catch (error) { if (!String(error.message).includes(String(row))) process.exit(1); }
}
process.exit(0);
