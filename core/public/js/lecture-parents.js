(function () {
  'use strict';

  var root = document.getElementById('readerParentLog');
  if (!root) return;
  var PACK_ID = root.dataset.packId || 'kidx_reader';
  var SCOPE_ID = root.dataset.scopeId || 'family';
  var LIMIT = '50';

  function $(id) { return document.getElementById(id); }

  function create(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  async function apiJson(url) {
    var res = await fetch(url, { credentials: 'include' });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok || body.status === 'error') {
      throw new Error(body.message || ('HTTP ' + res.status));
    }
    return body.data || body;
  }

  function textDigest(record) {
    if (!record) return '';
    if (record.text) return String(record.text);
    if (record.preview) return String(record.preview);
    if (record.length) return 'Hidden transcript (' + record.length + ' chars)';
    return '';
  }

  function formatDate(value) {
    if (!value) return 'n/a';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'n/a';
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatMs(value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '0 ms';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + ' s';
    return Math.round(n) + ' ms';
  }

  function compact(value, fallback) {
    var text = String(value || '').trim();
    return text || fallback || 'n/a';
  }

  function safetyStatus(item) {
    var safety = item.safety || {};
    var flags = Array.isArray(safety.flags) ? safety.flags.filter(Boolean) : [];
    var attention = Boolean(safety.requiresAttention || safety.deterministicEscalation);
    return {
      attention: attention,
      label: attention ? 'Attention' : flags.length ? 'Signal' : 'Clear',
      flags: flags
    };
  }

  function endpoint(path) {
    var params = new URLSearchParams({ packId: PACK_ID, scopeId: SCOPE_ID, limit: LIMIT });
    return path + '?' + params.toString();
  }

  function addMeta(list, label, value) {
    var wrap = create('div');
    wrap.appendChild(create('dt', '', label));
    wrap.appendChild(create('dd', '', value));
    list.appendChild(wrap);
  }

  function renderFlags(parent, status) {
    var badges = create('div', 'reader-log-badges');
    badges.appendChild(create(
      'span',
      status.attention ? 'reader-log-badge attention' : 'reader-log-badge clear',
      status.label
    ));
    if (status.flags.length) {
      status.flags.forEach(function (flag) {
        badges.appendChild(create('span', 'reader-log-badge flag', flag));
      });
    } else {
      badges.appendChild(create('span', 'reader-log-badge muted', 'No flags'));
    }
    parent.appendChild(badges);
  }

  function renderCard(item) {
    var status = safetyStatus(item);
    var card = create('article', 'reader-log-card' + (status.attention ? ' attention' : ''));

    var head = create('header', 'reader-log-card-head');
    var title = create('div');
    title.appendChild(create('span', 'reader-log-time', formatDate(item.createdAt)));
    title.appendChild(create('h2', '', textDigest(item.input) || 'No question text'));
    head.appendChild(title);
    var channel = create('span', 'reader-log-channel', compact(item.channel, 'text'));
    head.appendChild(channel);
    card.appendChild(head);

    var qa = create('div', 'reader-log-qa');
    var question = create('section');
    question.appendChild(create('span', 'reader-log-label', 'Asked'));
    question.appendChild(create('p', '', textDigest(item.input) || 'n/a'));
    qa.appendChild(question);
    var reply = create('section');
    reply.appendChild(create('span', 'reader-log-label', 'Reply'));
    reply.appendChild(create('p', '', textDigest(item.reply) || 'n/a'));
    qa.appendChild(reply);
    card.appendChild(qa);

    renderFlags(card, status);

    var meta = create('dl', 'reader-log-meta');
    addMeta(meta, 'Model', compact(item.model && item.model.model));
    addMeta(meta, 'Host', compact((item.model && item.model.hostKey) || (item.model && item.model.host)));
    addMeta(meta, 'Route', compact(item.routing && item.routing.taskType));
    addMeta(meta, 'Lane', compact((item.routing && item.routing.lane) || (item.routing && item.routing.source)));
    addMeta(meta, 'Total', formatMs(item.timings && item.timings.totalMs));
    addMeta(meta, 'Inference', formatMs(item.timings && item.timings.upstreamMs));
    addMeta(meta, 'Memory', formatMs(item.timings && item.timings.memoryMs));
    card.appendChild(meta);

    return card;
  }

  function renderSummary(items) {
    var attention = items.filter(function (item) { return safetyStatus(item).attention; }).length;
    var voice = items.filter(function (item) { return item.channel === 'voice'; }).length;
    $('readerLogCount').textContent = String(items.length);
    $('readerLogAttention').textContent = String(attention);
    $('readerLogVoice').textContent = String(voice);
    $('readerLogLatest').textContent = items.length ? formatDate(items[0].createdAt) : '--';
  }

  function renderAlert(alerts) {
    var panel = $('readerAlertPanel');
    if (!panel) return;
    var status = alerts && alerts.status ? alerts.status : 'clear';
    var rows = alerts && Array.isArray(alerts.alerts) ? alerts.alerts : [];
    panel.dataset.status = status;
    $('readerAlertStatus').textContent = status === 'attention'
      ? 'Attention'
      : status === 'review'
        ? 'Review'
        : 'Clear';
    $('readerAlertTitle').textContent = rows.length ? rows[0].title : 'Safety check';
    $('readerAlertMessage').textContent = alerts && alerts.recommendation
      ? alerts.recommendation
      : 'No recent voice persona safety alerts.';
  }

  function setStatus(message, tone) {
    var node = $('readerLogStatus');
    node.textContent = message;
    node.dataset.tone = tone || 'neutral';
  }

  function renderList(items) {
    var list = $('readerLogList');
    list.replaceChildren();
    if (!items.length) {
      setStatus('No reader turns recorded for the family scope yet.', 'empty');
      return;
    }
    setStatus('Showing the latest ' + items.length + ' reader turns.', 'ready');
    items.forEach(function (item) {
      list.appendChild(renderCard(item));
    });
  }

  async function load() {
    var button = $('readerLogRefresh');
    if (button) button.disabled = true;
    setStatus('Loading recent reader turns...', 'loading');
    try {
      var result = await Promise.all([
        apiJson(endpoint('/api/voice-personas/audit/recent')),
        apiJson(endpoint('/api/voice-personas/alerts'))
      ]);
      var items = Array.isArray(result[0].audit) ? result[0].audit : [];
      renderSummary(items);
      renderAlert(result[1].alerts || null);
      renderList(items);
    } catch (err) {
      renderSummary([]);
      renderAlert({
        status: 'attention',
        recommendation: 'Could not load reader audit or alert data.'
      });
      setStatus('Could not load reader audit data.', 'error');
      if (window.console) console.error('[lecture-parents] audit load failed', err);
    } finally {
      if (button) button.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var button = $('readerLogRefresh');
    if (button) button.addEventListener('click', load);
    load();
  });
})();
