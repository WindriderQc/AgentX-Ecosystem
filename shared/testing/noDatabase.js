'use strict';
process.env.NODE_ENV = 'test';
process.env.AGENTX_PROFILE ||= 'full';
process.env.OLLAMA_HOST ||= 'http://127.0.0.1:11434';
process.env.MONGOMS_RUNTIME_DOWNLOAD = 'false';
const forbidden = () => { throw new Error('NO_DB_TEST: real network/process access is forbidden'); };
require('net').Socket.prototype.connect = forbidden;
const childProcess = require('child_process');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = forbidden;
