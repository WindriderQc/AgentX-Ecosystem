'use strict';

const fs = require('fs');
const path = require('path');

describe('Backup trust UI', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../views/pages/backup.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../../public/js/backup.js'), 'utf8');

  test('shows cadence, retry, retention enforcement, and growth risk evidence', () => {
    expect(view).toContain('id="cfgScheduleStatus"');
    expect(view).toContain('id="cfgScheduleDetail"');
    expect(view).toContain('id="cfgRetentionPolicy"');
    expect(view).toContain('id="cfgGrowthRisk"');
    expect(view).toMatch(/does not delete anything immediately/i);
    expect(script).toMatch(/After partial\/failed cycles only/);
    expect(script).toMatch(/complete all-time inventory, paginated locally/);
  });

  test('provides a count-evidence target for every backup inventory', () => {
    for (const id of ['mongoEvidence', 'qdrantEvidence', 'configEvidence']) {
      expect(view).toContain(`id="${id}"`);
      expect(script).toContain(`renderInventoryEvidence('${id}', evidence)`);
    }
  });

  test('paginates large inventories and requires typed destructive confirmation', () => {
    for (const id of ['mongoPager', 'qdrantPager', 'configPager']) {
      expect(view).toContain(`id="${id}"`);
    }
    expect(view).toContain('id="backupConfirmDialog"');
    expect(view).toContain('id="backupConfirmExpected"');
    expect(script).toContain('const PAGE_SIZE = 25');
    expect(script).toMatch(/X-AgentX-Confirm/);
    expect(script).not.toMatch(/\bconfirm\s*\(/);
    expect(script).not.toContain('?confirm=true');
  });

  test('shows logical recovery storage and an honest offline restore state', () => {
    expect(view).toMatch(/persistent recovery storage/i);
    expect(view).toMatch(/controlled offline release rehearsal/i);
    expect(view).toMatch(/not proof of a coherent or restorable recovery set/i);
    expect(view).toMatch(/runtime env files, credentials, private adapters, data.*never captured/i);
    expect(script).toContain('Restore unavailable');
    expect(script).not.toMatch(/data-action="restore-/);
    expect(`${view}\n${script}`).not.toMatch(/id="(?:mongoRoot|qdrantRoot|configRoot|cfgBackupDir|cfgQdrantDir|cfgMongoUri|cfgRagUrl)"/);
  });
});
