'use strict';

const fs = require('fs');
const path = require('path');

const uiSource = fs.readFileSync(path.join(__dirname, '../../public/js/roundtable.js'), 'utf8');
const orchestratorSource = fs.readFileSync(path.join(__dirname, '../../src/services/roundtable/orchestrator.js'), 'utf8');

describe('Council terminal state contract', () => {
  test('a terminal event replaces RUNNING and closes the live stream', () => {
    expect(uiSource).toContain("liveDoc.status = data.status || liveDoc.status");
    expect(uiSource).toContain("String(data.status || 'finished').toUpperCase()");
    expect(uiSource).toContain('liveEventSource.close()');
  });

  test('the total timeout emits the same terminal receipt as panel failure', () => {
    expect(orchestratorSource).toContain("emitter.emit('chunk', { type: 'done', status: 'timeout'");
    expect(orchestratorSource).toContain("emitter.emit('chunk', { type: 'done', status: 'failed'");
  });
});
