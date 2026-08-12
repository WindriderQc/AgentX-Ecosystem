jest.mock('../../models/EmailAction', () => {
  const model = jest.fn();
  model.findOne = jest.fn();
  model.create = jest.fn();
  model.ACTION_CATEGORIES = ['Urgent', 'Needs Reply', 'Waiting'];
  return model;
});

const EmailAction = require('../../models/EmailAction');
const {
  EmailActionError,
  addEmailAction,
  buildDescription,
  normalizeInput,
} = require('../../src/services/emailActionService');

function document(values = {}) {
  return {
    gmailThreadId: '10f6012a48bd8cb7',
    category: 'Needs Reply',
    action: 'Reply to Vincent',
    leantimeProjectId: 4,
    leantimeTicketId: null,
    state: 'pending',
    dueAt: null,
    save: jest.fn().mockResolvedValue(true),
    ...values,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('normalizeInput', () => {
  test('accepts only actionable categories and computes the Gmail URL', () => {
    const result = normalizeInput({
      gmailThreadId: '10f6012a48bd8cb7',
      category: 'Urgent',
      action: '  Review   account notice\nnow  ',
    });
    expect(result.action).toBe('Review account notice now');
    expect(result.gmailUrl).toBe('https://mail.google.com/mail/#all/10f6012a48bd8cb7');
  });

  test('refuses Review and malformed ids', () => {
    expect(() => normalizeInput({ gmailThreadId: '10f6012a48bd8cb7', category: 'Review', action: 'Inspect' }))
      .toThrow(EmailActionError);
    expect(() => normalizeInput({ gmailThreadId: 'not an id', category: 'Waiting', action: 'Follow up' }))
      .toThrow(EmailActionError);
  });

  test('escapes untrusted metadata in the Leantime description', () => {
    const input = normalizeInput({
      gmailThreadId: '10f6012a48bd8cb7',
      category: 'Needs Reply',
      action: 'Reply',
      sender: '<img src=x onerror=alert(1)>',
      subject: '<script>bad()</script>',
    });
    const description = buildDescription(input);
    expect(description).not.toContain('<script>');
    expect(description).not.toContain('<img');
    expect(description).toContain('Gmail thread: 10f6012a48bd8cb7');
    expect(description).toContain('The email body remains in Gmail');
  });
});

describe('addEmailAction', () => {
  test('creates one Leantime ticket and persists its receipt', async () => {
    const doc = document();
    EmailAction.findOne.mockResolvedValue(null);
    EmailAction.create.mockResolvedValue(doc);
    const rpc = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(88);

    const result = await addEmailAction({
      gmailThreadId: '10f6012a48bd8cb7',
      gmailMessageId: '10f6012a48bd8cb7',
      category: 'Needs Reply',
      action: 'Reply to Vincent',
      sender: 'hotmail.com',
      messageDate: '2006-12-07 22:19',
    }, { model: EmailAction, rpc });

    expect(rpc.mock.calls[0][0]).toBe('leantime.rpc.Tickets.getAll');
    expect(rpc.mock.calls[1][0]).toBe('leantime.rpc.Tickets.quickAddTicket');
    expect(rpc.mock.calls[1][1].params).toEqual(expect.objectContaining({
      projectId: 4,
      headline: 'Reply to Vincent',
      status: 3,
    }));
    expect(doc.leantimeTicketId).toBe(88);
    expect(doc.state).toBe('active');
    expect(doc.save).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ created: true, leantimeTicketId: 88 }));
  });

  test('is idempotent when a receipt already has a ticket id', async () => {
    const doc = document({ leantimeTicketId: 91, state: 'active' });
    EmailAction.findOne.mockResolvedValue(doc);
    const rpc = jest.fn();

    const result = await addEmailAction({
      gmailThreadId: '10f6012a48bd8cb7',
      category: 'Needs Reply',
      action: 'Reply to Vincent',
    }, { model: EmailAction, rpc });

    expect(rpc).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ created: false, leantimeTicketId: 91 }));
  });

  test('coalesces concurrent retries for the same Gmail thread', async () => {
    const doc = document();
    EmailAction.findOne.mockResolvedValue(null);
    EmailAction.create.mockResolvedValue(doc);
    const rpc = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(92);
    const input = {
      gmailThreadId: '10f6012a48bd8cb7',
      category: 'Needs Reply',
      action: 'Reply to Vincent',
    };

    const [first, second] = await Promise.all([
      addEmailAction(input, { model: EmailAction, rpc }),
      addEmailAction(input, { model: EmailAction, rpc }),
    ]);

    expect(EmailAction.create).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(first.leantimeTicketId).toBe(92);
    expect(second.leantimeTicketId).toBe(92);
  });

  test('recovers a remote ticket by Gmail marker after an interrupted save', async () => {
    const doc = document();
    EmailAction.findOne.mockResolvedValue(doc);
    const rpc = jest.fn().mockResolvedValueOnce([{
      id: 99,
      projectId: 4,
      description: 'Gmail thread: 10f6012a48bd8cb7',
    }]);

    const result = await addEmailAction({
      gmailThreadId: '10f6012a48bd8cb7',
      category: 'Needs Reply',
      action: 'Reply to Vincent',
    }, { model: EmailAction, rpc });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ recovered: true, leantimeTicketId: 99 }));
  });

  test('verifies by Gmail marker when Leantime returns opaque success', async () => {
    const doc = document({ gmailThreadId: '20f6012a48bd8cb7' });
    EmailAction.findOne.mockResolvedValue(null);
    EmailAction.create.mockResolvedValue(doc);
    const rpc = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce([{
        id: 101,
        projectId: 4,
        description: 'Gmail thread: 20f6012a48bd8cb7',
      }]);

    const result = await addEmailAction({
      gmailThreadId: '20f6012a48bd8cb7',
      category: 'Urgent',
      action: 'Renew affiliation',
    }, { model: EmailAction, rpc });

    expect(rpc.mock.calls.map(([method]) => method)).toEqual([
      'leantime.rpc.Tickets.getAll',
      'leantime.rpc.Tickets.quickAddTicket',
      'leantime.rpc.Tickets.getAll',
    ]);
    expect(result).toEqual(expect.objectContaining({ recovered: true, leantimeTicketId: 101 }));
  });
});
