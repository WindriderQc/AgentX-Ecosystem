const {
  normalizeAlertForRead,
  projectHealthFeed
} = require('../../src/services/alertFeedProjection');

describe('alertFeedProjection', () => {
  it('resolves legacy template tokens from persisted alert context without mutating history', () => {
    const persisted = {
      _id: 'alert-1',
      title: 'VRAM displacement — {{component}}',
      message: 'Displacement event on {{component}}',
      ruleName: 'Displacement {{component}}',
      context: { component: 'scheduler' }
    };

    const presented = normalizeAlertForRead(persisted);

    expect(presented).not.toBe(persisted);
    expect(presented.title).toBe('VRAM displacement — scheduler');
    expect(presented.message).toBe('Displacement event on scheduler');
    expect(presented.ruleName).toBe('Displacement scheduler');
    expect(presented.presentation).toEqual(expect.objectContaining({
      templateStatus: 'resolved',
      missingTemplateFields: []
    }));
    expect(JSON.stringify(presented)).not.toContain('{{component}}');
    expect(persisted.title).toContain('{{component}}');
  });

  it('labels missing legacy template evidence instead of exposing or guessing the token', () => {
    const presented = normalizeAlertForRead({
      title: 'VRAM displacement — {{component}}',
      message: 'No component evidence',
      ruleName: 'Displacement'
    });

    expect(presented.title).toBe('VRAM displacement — [missing:component]');
    expect(presented.presentation).toEqual(expect.objectContaining({
      templateStatus: 'incomplete',
      missingTemplateFields: ['component']
    }));
  });

  it('groups repeated cancellation history before applying the display limit', () => {
    const inferenceLogs = Array.from({ length: 20 }, (_, index) => ({
      _id: `cancel-${index}`,
      status: 'error',
      model: 'model-a',
      hostKey: 'primary',
      caller: 'chat',
      taskType: 'general_chat',
      error: index % 2 === 0 ? 'Inference request cancelled.' : 'Inference request canceled.',
      timestamp: new Date(Date.UTC(2026, 7, 28, 12, index)).toISOString()
    }));
    inferenceLogs.push({
      _id: 'distinct-timeout',
      status: 'timeout',
      model: 'model-b',
      hostKey: 'secondary',
      error: 'upstream timed out',
      timestamp: '2026-08-28T11:00:00.000Z'
    });

    const projection = projectHealthFeed({ inferenceLogs, limit: 20 });

    expect(projection.events).toHaveLength(2);
    const cancelled = projection.events.find(event => event.type === 'inference_cancelled');
    expect(cancelled).toEqual(expect.objectContaining({
      severity: 'info',
      outcome: 'cancelled',
      groupedCount: 20,
      occurrenceCount: 20
    }));
    expect(cancelled.memberIds).toHaveLength(20);
    expect(cancelled.grouping).toEqual({
      grouped: true,
      persistedRows: 20,
      preservedIds: 20
    });
    expect(projection.meta).toEqual(expect.objectContaining({
      candidateRows: 21,
      presentedRows: 2,
      groupedRows: 19
    }));
    expect(inferenceLogs).toHaveLength(21);
  });

  it('groups equivalent resolved history but keeps a current active incident distinct', () => {
    const base = {
      fingerprint: 'same-incident-family',
      severity: 'warning',
      title: 'Host warning',
      message: 'Host warning',
      context: { component: 'primary' }
    };
    const projection = projectHealthFeed({
      alerts: [
        { ...base, _id: 'resolved-1', status: 'resolved', occurrenceCount: 2, createdAt: '2026-08-28T09:00:00Z' },
        { ...base, _id: 'resolved-2', status: 'resolved', occurrenceCount: 3, createdAt: '2026-08-28T10:00:00Z' },
        { ...base, _id: 'active-1', status: 'active', occurrenceCount: 1, createdAt: '2026-08-28T11:00:00Z' }
      ]
    });

    expect(projection.events).toHaveLength(2);
    const active = projection.events.find(event => event.lifecycle === 'active');
    const history = projection.events.find(event => event.lifecycle === 'history');
    expect(active).toEqual(expect.objectContaining({ id: 'active-1', groupedCount: 1 }));
    expect(history).toEqual(expect.objectContaining({
      status: 'resolved',
      groupedCount: 2,
      occurrenceCount: 5
    }));
    expect(history.memberIds).toEqual(expect.arrayContaining(['resolved-1', 'resolved-2']));
  });

  it('keeps an old active incident in a limited feed and ignores overlapping snapshot input', () => {
    const active = {
      _id: 'active-old',
      fingerprint: 'active-old',
      status: 'active',
      severity: 'warning',
      title: 'Still active',
      message: 'Still active',
      createdAt: '2026-08-28T08:00:00Z'
    };
    const projection = projectHealthFeed({
      alerts: [
        active,
        { ...active },
        { _id: 'history-new', fingerprint: 'history-new', status: 'resolved', severity: 'info', title: 'New history', message: 'New history', createdAt: '2026-08-28T12:00:00Z' },
        { _id: 'history-mid', fingerprint: 'history-mid', status: 'resolved', severity: 'info', title: 'Mid history', message: 'Mid history', createdAt: '2026-08-28T11:00:00Z' }
      ],
      limit: 2
    });

    expect(projection.events.map(event => event.id)).toEqual(['history-new', 'active-old']);
    expect(projection.events.find(event => event.id === 'active-old').groupedCount).toBe(1);
    expect(projection.meta).toEqual(expect.objectContaining({
      candidateRows: 3,
      duplicateInputsIgnored: 1,
      presentedRows: 2,
      truncatedGroups: 1
    }));
  });
});
