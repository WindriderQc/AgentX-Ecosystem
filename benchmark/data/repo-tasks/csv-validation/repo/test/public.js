const parseScores = require('../src/parseScores');
const rows = parseScores(' Ada , 98\n\nBob,75');
if (rows.length !== 2 || rows[0].name !== 'Ada' || rows[0].score !== 98) process.exit(1);
try { parseScores('Ada,101'); process.exit(1); } catch (error) { if (!/1/.test(error.message)) process.exit(1); }
process.exit(0);
