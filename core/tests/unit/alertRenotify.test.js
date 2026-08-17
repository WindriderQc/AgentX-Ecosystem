/**
 * Sustained-alert re-notification (task 0541).
 *
 * The defect these cover, measured in production: alert dedup keys one
 * incident per fingerprint and skipped notification on every recurrence. A
 * condition that keeps failing therefore stays `active`, never goes stale,
 * never resolves, and never produces a second notification — one .12 Ollama
 * outage held 323 occurrences over 26 hours behind a single Telegram message.
 * Intermittent problems resolve and re-fire (and do notify); constant ones go
 * silent, so the more constantly something fails the quieter it gets.
 *
 * These assert delivery behaviour on the real dedup path rather than the
 * helper in isolation — the bug lived in the wiring, not the arithmetic.
 */

const Alert = require('../../models/Alert');
const alertService = require('../../src/services/alertService');
const { formatAlertText } = require('../../src/services/notificationFormatters');

const RULE_ID = 'renotify-test-rule';
const HOST_DOWN_EVENT = {
  component: 'secondary',
  metric: 'host_unreachable',
  value: 1,
  source: 'unit-test',
  additionalData: { host: 'secondary', model: 'nomic-embed-text:v1.5' }
};

function ruleWith(renotifyMs) {
  return {
    id: RULE_ID,
    name: 'Renotify test rule',
    enabled: true,
    severity: 'critical',
    channels: ['local_log'],
    conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'host_unreachable' }] },
    renotifyMs
  };
}

describe('sustained-alert re-notification (0541)', () => {
  let sendSpy;

  beforeAll(() => {
    process.env.ALERT_TEST_MODE = 'true';
  });

  beforeEach(async () => {
    await Alert.deleteMany({});
    sendSpy = jest.spyOn(alertService, '_sendNotifications').mockResolvedValue({});
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  afterAll(async () => {
    await Alert.deleteMany({});
    delete process.env.ALERT_TEST_MODE;
  });

  /** Age the incident so the next re-notification is due. */
  async function backdateNotification(ms) {
    await Alert.updateOne(
      { ruleId: RULE_ID, status: 'active' },
      { $set: { lastNotifiedAt: new Date(Date.now() - ms) } }
    );
  }

  it('does not re-notify when renotifyMs is 0, preserving existing behaviour', async () => {
    alertService.loadRules([ruleWith(0)]);

    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    expect(sendSpy).toHaveBeenCalledTimes(1); // creation

    await backdateNotification(24 * 60 * 60 * 1000);
    await alertService.evaluateEvent(HOST_DOWN_EVENT);

    // Every existing rule defaults to 0, so opting in must be the only way to
    // change what an operator already receives.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const alert = await Alert.findOne({ ruleId: RULE_ID });
    expect(alert.occurrenceCount).toBe(2);
    expect(alert.notificationCount).toBe(1);
  });

  it('stays quiet while the incident is younger than the interval', async () => {
    alertService.loadRules([ruleWith(15 * 60 * 1000)]);

    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    await alertService.evaluateEvent(HOST_DOWN_EVENT);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const alert = await Alert.findOne({ ruleId: RULE_ID });
    expect(alert.occurrenceCount).toBe(3);
  });

  it('re-notifies an ongoing incident once the interval has elapsed', async () => {
    // The regression this whole task exists for: a still-failing condition
    // must speak up again instead of going quiet behind a counter.
    alertService.loadRules([ruleWith(15 * 60 * 1000)]);

    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    await backdateNotification(16 * 60 * 1000);
    await alertService.evaluateEvent(HOST_DOWN_EVENT);

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const alert = await Alert.findOne({ ruleId: RULE_ID });
    expect(alert.notificationCount).toBe(2);
    expect(alert.occurrenceCount).toBe(2);
    // Same incident, not a second one — dedup itself must be untouched.
    expect(await Alert.countDocuments({ ruleId: RULE_ID })).toBe(1);
  });

  it('escalates the interval so a long outage reports in without spamming', async () => {
    alertService.loadRules([ruleWith(15 * 60 * 1000)]);

    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    await backdateNotification(16 * 60 * 1000);
    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    expect(sendSpy).toHaveBeenCalledTimes(2);

    // 16 minutes was enough for the first repeat; the second wants ~30.
    await backdateNotification(16 * 60 * 1000);
    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    expect(sendSpy).toHaveBeenCalledTimes(2);

    await backdateNotification(31 * 60 * 1000);
    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });

  it('caps the backoff so a multi-day incident cannot go silent again', () => {
    const capped = alertService._renotifyDueAt(
      { notificationCount: 40, lastNotifiedAt: new Date('2026-08-12T00:00:00Z') },
      15 * 60 * 1000
    );
    // 15m doubled 39 times is astronomically large; the cap is what keeps a
    // long incident reporting rather than escalating itself into silence.
    const maxMs = 6 * 60 * 60 * 1000;
    expect(capped.getTime()).toBe(new Date('2026-08-12T00:00:00Z').getTime() + maxMs);
  });

  it('stops nagging once an operator acknowledges the incident', async () => {
    alertService.loadRules([ruleWith(15 * 60 * 1000)]);

    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    await Alert.updateOne({ ruleId: RULE_ID }, { $set: { status: 'acknowledged' } });
    await backdateNotification(24 * 60 * 60 * 1000);
    await alertService.evaluateEvent(HOST_DOWN_EVENT);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('marks a repeat notification as ongoing so it is not read as a duplicate', () => {
    const base = {
      title: 'Host unreachable — secondary',
      severity: 'critical',
      ruleName: 'Ollama host unreachable',
      message: 'nomic-embed-text:v1.5: unreachable',
      context: {},
      createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
      occurrenceCount: 200,
      _id: 'abc'
    };

    const first = formatAlertText({ ...base, notificationCount: 1 });
    expect(first).not.toContain('STILL UNRESOLVED');

    const repeat = formatAlertText({ ...base, notificationCount: 4 });
    expect(repeat).toContain('STILL UNRESOLVED after 9.0h');
    expect(repeat).toContain('reminder #3');
    expect(repeat).toContain('200 occurrences');
  });

  it('never lets a notification failure break alert recording', async () => {
    alertService.loadRules([ruleWith(15 * 60 * 1000)]);

    await alertService.evaluateEvent(HOST_DOWN_EVENT);
    await backdateNotification(16 * 60 * 1000);
    sendSpy.mockRejectedValueOnce(new Error('telegram unreachable'));

    await expect(alertService.evaluateEvent(HOST_DOWN_EVENT)).resolves.toBeDefined();
    const alert = await Alert.findOne({ ruleId: RULE_ID });
    expect(alert.occurrenceCount).toBe(2);
  });
});
