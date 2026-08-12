const EmailAction = require('../../models/EmailAction');
const { ACTION_CATEGORIES } = require('../../models/EmailAction');

const EMAIL_ACTION_PROJECT_ID = Number(process.env.LEANTIME_EMAIL_ACTION_PROJECT_ID || 4);
const LEANTIME_USER_ID = Number(process.env.LEANTIME_EMAIL_ACTION_USER_ID || 7);
const MAX_ERROR_CHARS = 500;
const inFlightByThread = new Map();

class EmailActionError extends Error {
  constructor(message, { code = 'EMAIL_ACTION_ERROR', status = 400 } = {}) {
    super(message);
    this.name = 'EmailActionError';
    this.code = code;
    this.status = status;
  }
}

function compactText(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDueAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new EmailActionError('dueAt must be an ISO date or datetime', {
      code: 'EMAIL_ACTION_BAD_DUE_DATE'
    });
  }
  return parsed;
}

function normalizeInput(input = {}) {
  const gmailThreadId = compactText(input.gmailThreadId, 256);
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(gmailThreadId)) {
    throw new EmailActionError('gmailThreadId is required and must be an exact Gmail thread id', {
      code: 'EMAIL_ACTION_BAD_THREAD_ID'
    });
  }
  const category = compactText(input.category, 40);
  if (!ACTION_CATEGORIES.includes(category)) {
    throw new EmailActionError(`category must be one of ${ACTION_CATEGORIES.join(', ')}`, {
      code: 'EMAIL_ACTION_BAD_CATEGORY'
    });
  }
  const action = compactText(input.action, 200);
  if (!action) {
    throw new EmailActionError('action is required', { code: 'EMAIL_ACTION_ACTION_REQUIRED' });
  }
  const gmailMessageId = compactText(input.gmailMessageId, 256);
  if (gmailMessageId && !/^[A-Za-z0-9_-]{8,256}$/.test(gmailMessageId)) {
    throw new EmailActionError('gmailMessageId must be an exact Gmail message id', {
      code: 'EMAIL_ACTION_BAD_MESSAGE_ID'
    });
  }
  return {
    gmailThreadId,
    gmailMessageId,
    category,
    action,
    subject: compactText(input.subject, 300),
    sender: compactText(input.sender, 200),
    messageDate: compactText(input.messageDate, 60),
    dueAt: parseDueAt(input.dueAt),
    gmailUrl: `https://mail.google.com/mail/#all/${gmailThreadId}`,
    leantimeProjectId: EMAIL_ACTION_PROJECT_ID,
  };
}

function leantimeBaseUrl() {
  const baseUrl = String(process.env.LEANTIME_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new EmailActionError('LEANTIME_BASE_URL is not configured', {
      code: 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED',
      status: 503
    });
  }
  return baseUrl;
}

async function leantimeRpc(method, params, attempt = 0) {
  const key = process.env.LEANTIME_API_KEY || '';
  if (!key) {
    throw new EmailActionError('LEANTIME_API_KEY is not configured', {
      code: 'EMAIL_ACTION_LEANTIME_NOT_CONFIGURED',
      status: 503
    });
  }
  const response = await fetch(`${leantimeBaseUrl()}/api/jsonrpc`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (response.status === 429 && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, 1000 + attempt * 1000));
    return leantimeRpc(method, params, attempt + 1);
  }
  if (!response.ok) {
    throw new EmailActionError(`Leantime RPC ${method} returned HTTP ${response.status}`, {
      code: 'EMAIL_ACTION_LEANTIME_HTTP',
      status: 502
    });
  }
  const body = await response.json();
  if (body?.error) {
    throw new EmailActionError(`Leantime RPC ${method} failed: ${body.error.message || 'unknown error'}`, {
      code: 'EMAIL_ACTION_LEANTIME_RPC',
      status: 502
    });
  }
  return body?.result;
}

function markerFor(threadId) {
  return `Gmail thread: ${threadId}`;
}

function buildDescription(input) {
  const lines = [
    '<p>Email action captured by Nestor.</p>',
    `<p><strong>Category:</strong> ${escapeHtml(input.category)}<br>`,
    `<strong>Sender:</strong> ${escapeHtml(input.sender || 'unknown')}<br>`,
    `<strong>Message date:</strong> ${escapeHtml(input.messageDate || 'unknown')}<br>`,
    `<strong>Subject:</strong> ${escapeHtml(input.subject || 'not retained')}<br>`,
    `<strong>${escapeHtml(markerFor(input.gmailThreadId))}</strong></p>`,
    `<p><a href="${input.gmailUrl}">Open the Gmail thread</a></p>`,
    '<p>The email body remains in Gmail and is not copied into Leantime.</p>',
  ];
  return lines.join('');
}

async function findExistingTicket(input, rpc) {
  const tickets = await rpc('leantime.rpc.Tickets.getAll', {
    searchCriteria: { currentProject: EMAIL_ACTION_PROJECT_ID, status: '' }
  });
  const marker = markerFor(input.gmailThreadId);
  return (Array.isArray(tickets) ? tickets : []).find((ticket) =>
    Number(ticket?.projectId) === EMAIL_ACTION_PROJECT_ID
      && String(ticket?.description || '').includes(marker));
}

async function ensureLeantimeTicket(input, rpc) {
  const existing = await findExistingTicket(input, rpc);
  if (existing?.id) return { ticketId: Number(existing.id), recovered: true };

  const ticketResult = await rpc('leantime.rpc.Tickets.quickAddTicket', {
    params: {
      projectId: EMAIL_ACTION_PROJECT_ID,
      userId: LEANTIME_USER_ID,
      type: 'task',
      status: 3,
      headline: input.action,
      description: buildDescription(input),
      ...(input.dueAt ? { dateToFinish: input.dueAt.toISOString() } : {}),
    }
  });
  const rawTicketId = ticketResult && typeof ticketResult === 'object'
    ? (ticketResult.id ?? ticketResult.ticketId)
    : ticketResult;
  const numericId = ['number', 'string'].includes(typeof rawTicketId)
    ? Number(rawTicketId)
    : Number.NaN;
  if (!Number.isFinite(numericId) || numericId <= 0) {
    const verified = await findExistingTicket(input, rpc);
    if (verified?.id) return { ticketId: Number(verified.id), recovered: true };
  }
  if (!Number.isFinite(numericId) || numericId <= 0) {
    throw new EmailActionError('Leantime did not return a ticket id', {
      code: 'EMAIL_ACTION_LEANTIME_CREATE_FAILED',
      status: 502
    });
  }
  return { ticketId: numericId, recovered: false };
}

function serialize(record, { created = false, recovered = false } = {}) {
  const value = typeof record.toObject === 'function' ? record.toObject() : record;
  return {
    created,
    recovered,
    gmailThreadId: value.gmailThreadId,
    category: value.category,
    action: value.action,
    dueAt: value.dueAt ? new Date(value.dueAt).toISOString() : null,
    leantimeProjectId: value.leantimeProjectId,
    leantimeTicketId: value.leantimeTicketId,
    leantimeUrl: `${leantimeBaseUrl()}/dashboard/home#/tickets/showTicket/${value.leantimeTicketId}`,
    state: value.state,
  };
}

async function writeEmailAction(normalized, deps) {
  const model = deps.model || EmailAction;
  const rpc = deps.rpc || leantimeRpc;
  let record = await model.findOne({ gmailThreadId: normalized.gmailThreadId });
  if (record?.leantimeTicketId) return serialize(record);

  let created = false;
  if (!record) {
    try {
      record = await model.create({ ...normalized, state: 'pending' });
      created = true;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      record = await model.findOne({ gmailThreadId: normalized.gmailThreadId });
    }
  }
  if (!record) throw new EmailActionError('Could not create the email-action receipt', { status: 500 });
  if (record.leantimeTicketId) return serialize(record);

  try {
    const result = await ensureLeantimeTicket(normalized, rpc);
    Object.assign(record, normalized, {
      leantimeTicketId: result.ticketId,
      state: 'active',
      lastError: '',
    });
    await record.save();
    return serialize(record, { created, recovered: result.recovered });
  } catch (err) {
    record.state = 'error';
    record.lastError = compactText(err.message, MAX_ERROR_CHARS);
    await record.save();
    throw err;
  }
}

async function addEmailAction(input = {}, deps = {}) {
  const normalized = normalizeInput(input);
  const existing = inFlightByThread.get(normalized.gmailThreadId);
  if (existing) return existing;

  const pending = writeEmailAction(normalized, deps);
  inFlightByThread.set(normalized.gmailThreadId, pending);
  try {
    return await pending;
  } finally {
    if (inFlightByThread.get(normalized.gmailThreadId) === pending) {
      inFlightByThread.delete(normalized.gmailThreadId);
    }
  }
}

module.exports = {
  EmailActionError,
  EMAIL_ACTION_PROJECT_ID,
  ACTION_CATEGORIES,
  addEmailAction,
  normalizeInput,
  buildDescription,
  markerFor,
};
