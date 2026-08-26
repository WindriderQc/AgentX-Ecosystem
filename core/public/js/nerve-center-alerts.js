(function () {
    'use strict';
    const shared = window.NerveCenterShared;
    if (!shared) return;

    let _poller = null;

    const SEV_COLORS = { critical: '#f87171', error: '#fb923c', warning: '#f59e0b', info: '#7cf0ff' };
    const OPERATOR_LABELS = {
        equal: '==', greaterThan: '>', lessThan: '<',
        greaterThanOrEqual: '>=', lessThanOrEqual: '<=', notEqual: '!=',
        contains: 'contains', matches: 'matches',
    };

    async function loadAlerts() {
        const body = document.getElementById('nc-alerts-body');
        if (!body) return;

        try {
            const [alertsRes, summaryRes, rulesRes] = await Promise.all([
                shared.fetchJson('/api/alerts?status=active&limit=20'),
                shared.fetchJson('/api/alerts/stats/summary?status=active'),
                shared.fetchJson('/api/alerts/rules').catch(() => ({ data: { rules: [] } })),
            ]);

            const alerts = alertsRes.data || alertsRes || [];
            const summary = summaryRes.data?.statistics || summaryRes.data || summaryRes || {};
            const rules = (rulesRes.data && rulesRes.data.rules) || [];
            const detectorCoverage = rulesRes.data?.detectorCoverage || {
                active: rules.filter(r => r.detectorState === 'active' || (!r.detectorState && r.enabled)).length,
                disabled: rules.filter(r => r.detectorState === 'disabled' || (!r.detectorState && !r.enabled)).length,
                retired_by_design: rules.filter(r => r.detectorState === 'retired_by_design').length,
            };

            const severityCounts = summary.bySeverity || {};
            const critical = severityCounts.critical || 0;
            const error = severityCounts.error || 0;
            const warning = severityCounts.warning || 0;
            const info = severityCounts.info || 0;

            const coverageDegraded = detectorCoverage.disabled > 0;
            let html = `
                <div class="nc-host-card" style="margin-bottom:16px;padding:12px;border-left:3px solid ${coverageDegraded ? '#f59e0b' : '#4ade80'}">
                    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
                        <strong style="color:${coverageDegraded ? '#f59e0b' : '#4ade80'}">
                            ${coverageDegraded ? 'MONITORING COVERAGE DEGRADED' : 'DETECTOR COVERAGE'}
                        </strong>
                        <span>${detectorCoverage.active || 0} active</span>
                        <a href="#nc-rules-table" style="color:${coverageDegraded ? '#f59e0b' : 'var(--muted)'}">${detectorCoverage.disabled || 0} disabled</a>
                        <span class="nc-muted">${detectorCoverage.retired_by_design || 0} retired by design</span>
                    </div>
                    ${coverageDegraded ? '<div class="nc-muted nc-fs-sm" style="margin-top:5px">No active alerts does not mean all clear while configured detectors are disabled.</div>' : ''}
                </div>
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
                    <div class="nc-host-card" style="border-left:3px solid #f87171;padding:12px">
                        <div class="nc-muted nc-fs-sm">Critical</div>
                        <div style="font-size:1.4em;font-weight:700;color:${critical > 0 ? '#f87171' : '#93a0b5'}">${critical}</div>
                    </div>
                    <div class="nc-host-card" style="border-left:3px solid #fb923c;padding:12px">
                        <div class="nc-muted nc-fs-sm">Error</div>
                        <div style="font-size:1.4em;font-weight:700;color:${error > 0 ? '#fb923c' : '#93a0b5'}">${error}</div>
                    </div>
                    <div class="nc-host-card" style="border-left:3px solid #f59e0b;padding:12px">
                        <div class="nc-muted nc-fs-sm">Warning</div>
                        <div style="font-size:1.4em;font-weight:700;color:${warning > 0 ? '#f59e0b' : '#93a0b5'}">${warning}</div>
                    </div>
                    <div class="nc-host-card" style="border-left:3px solid #7cf0ff;padding:12px">
                        <div class="nc-muted nc-fs-sm">Info</div>
                        <div style="font-size:1.4em;font-weight:700;color:${info > 0 ? '#7cf0ff' : '#93a0b5'}">${info}</div>
                    </div>
                </div>`;

            // Active alerts table
            const alertList = Array.isArray(alerts) ? alerts : (alerts.alerts || []);
            if (alertList.length > 0) {
                html += `<h4 style="color:var(--text-bright);margin:0 0 8px"><i class="fa-solid fa-bell"></i> Active Alerts</h4>`;
                html += `<table class="nc-table"><thead><tr>
                    <th>Severity</th><th>Alert</th><th>Where</th><th>Count</th><th>Last Seen</th><th>Actions</th>
                </tr></thead><tbody>`;

                for (const a of alertList) {
                    const sevColor = SEV_COLORS[a.severity] || '#93a0b5';
                    const ctx = a.context || {};
                    const extra = ctx.additionalData || {};
                    const metaBits = [
                        extra.model ? `${extra.model}${extra.host ? ' on ' + extra.host : ''}` : '',
                        ctx.metric ? `${ctx.metric}${ctx.currentValue !== undefined && ctx.currentValue !== null ? ' = ' + ctx.currentValue : ''}` : '',
                        a.ruleName || ''
                    ].filter(Boolean).join(' · ');
                    const metaLine = metaBits
                        ? `<div style="font-size:0.7rem;color:var(--muted);margin-top:2px;">${shared.escapeHtml(metaBits)}</div>`
                        : '';
                    html += `<tr>
                        <td><span style="color:${sevColor}">&bull; ${shared.escapeHtml(a.severity || '')}</span></td>
                        <td>${shared.escapeHtml(a.title || '')}${metaLine}</td>
                        <td><span class="nc-model-tag">${shared.escapeHtml(ctx.component || a.source || 'unknown')}</span></td>
                        <td>${a.occurrenceCount > 1 ? `${a.occurrenceCount}×` : '1×'}</td>
                        <td>${shared.timeAgo(a.lastOccurrence || a.createdAt)}</td>
                        <td>
                            <button class="nc-btn" data-ack="${a._id}">Ack</button>
                            <button class="nc-btn" data-resolve="${a._id}">Resolve</button>
                        </td>
                    </tr>`;
                }
                html += `</tbody></table>`;
            } else {
                html += `<p class="nc-muted" style="text-align:center;padding:16px">No active alerts${coverageDegraded ? ' — monitoring coverage is degraded' : ''}</p>`;
            }

            // ── Rules table (dynamic from API) ──
            html += `<h4 style="color:var(--text-bright);margin:20px 0 8px;display:flex;align-items:center;gap:12px">
                <span><i class="fa-solid fa-shield-halved"></i> Alert Rules</span>
                <button class="nc-btn" id="nc-add-rule-btn" style="font-size:10px;padding:3px 10px;margin-left:auto"><i class="fas fa-plus"></i> Add Rule</button>
                <button class="nc-btn" id="nc-bulk-resolve-btn" style="font-size:10px;padding:3px 10px;border-color:rgba(248,113,113,0.3);color:#f87171"><i class="fas fa-broom"></i> Resolve Old</button>
            </h4>`;
            html += buildRulesTable(rules);

            // ── Inline rule editor (hidden by default) ──
            html += buildRuleEditor();

            body.innerHTML = html;
            attachAlertHandlers(body);
            attachRuleHandlers(body, rules);
        } catch (err) {
            body.innerHTML = `<p class="nc-muted" style="text-align:center;padding:16px">Alert service unavailable</p>`;
        }

        if (!_poller) {
            _poller = new window.PollingController();
            _poller.addTask('alerts', loadAlerts, 30000, { runOnStart: false });
            _poller.start();
        }
    }

    function buildRulesTable(rules) {
        if (rules.length === 0) {
            return `<p class="nc-muted" style="text-align:center;padding:12px">No rules configured. <a href="#" id="nc-seed-defaults" style="color:#7cf0ff">Load defaults</a></p>`;
        }
        let rows = '';
        for (const r of rules) {
            const sevColor = SEV_COLORS[r.severity] || '#93a0b5';
            const detectorState = r.detectorState || (r.enabled ? 'active' : 'disabled');
            const retired = detectorState === 'retired_by_design';
            const condText = (r.conditions?.all || []).map(c =>
                `${shared.escapeHtml(c.fact)} ${OPERATOR_LABELS[c.operator] || c.operator} ${shared.escapeHtml(String(c.value))}`
            ).join(' AND ') || '<span class="nc-muted">no conditions</span>';

            rows += `<tr data-rule-id="${shared.escapeHtml(r.ruleId)}">
                <td class="nc-td-md">${shared.escapeHtml(r.name)}${r.builtIn ? ' <span class="nc-muted" style="font-size:0.75em">(built-in)</span>' : ''}</td>
                <td class="nc-td-md"><span style="color:${sevColor}">&bull; ${shared.escapeHtml(r.severity)}</span></td>
                <td style="padding:8px 10px;font-size:0.85em;font-family:monospace">${condText}</td>
                <td class="nc-td-md">
                    <button class="nc-btn nc-rule-toggle" data-rule="${shared.escapeHtml(r.ruleId)}" data-enabled="${r.enabled}" ${retired ? 'disabled' : ''} title="${shared.escapeHtml(r.stateReason || '')}" style="font-size:10px;padding:3px 8px">
                        ${detectorState === 'active'
                            ? '<span style="color:#4ade80">&bull; ACTIVE</span>'
                            : detectorState === 'retired_by_design'
                                ? '<span class="nc-muted">&bull; RETIRED</span>'
                                : '<span style="color:#f59e0b">&bull; DISABLED</span>'}
                    </button>
                </td>
                <td style="padding:8px 10px;text-align:center">
                    <button class="nc-btn nc-rule-edit" data-rule="${shared.escapeHtml(r.ruleId)}" style="font-size:10px;padding:3px 8px;margin-right:4px"><i class="fas fa-pen"></i></button>
                    ${!r.builtIn ? `<button class="nc-btn nc-rule-delete" data-rule="${shared.escapeHtml(r.ruleId)}" style="font-size:10px;padding:3px 8px;border-color:rgba(248,113,113,0.3);color:#f87171"><i class="fas fa-trash"></i></button>` : ''}
                </td>
            </tr>`;
        }
        return `<table class="nc-table" id="nc-rules-table"><thead><tr>
            <th>Rule</th><th>Severity</th><th>Conditions</th><th>Status</th><th style="text-align:center;width:100px"></th>
        </tr></thead><tbody>${rows}</tbody></table>`;
    }

    function buildRuleEditor() {
        return `<div id="nc-rule-editor" style="display:none;margin-top:12px;padding:14px;background:rgba(18,23,38,0.6);border:1px solid rgba(255,255,255,0.08);border-radius:8px">
            <h5 style="margin:0 0 10px;color:var(--text-bright);font-size:0.9rem" id="nc-rule-editor-title">New Alert Rule</h5>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
                <div>
                    <label class="nc-muted nc-fs-sm-block">Rule ID</label>
                    <input id="nc-rule-id" class="nc-inline-select nc-select-sm" placeholder="my-custom-rule">
                </div>
                <div>
                    <label class="nc-muted nc-fs-sm-block">Name</label>
                    <input id="nc-rule-name" class="nc-inline-select nc-select-sm" placeholder="My Custom Rule">
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
                <div>
                    <label class="nc-muted nc-fs-sm-block">Severity</label>
                    <select id="nc-rule-severity" class="nc-inline-select nc-select-sm">
                        <option value="info">Info</option>
                        <option value="warning" selected>Warning</option>
                        <option value="error">Error</option>
                        <option value="critical">Critical</option>
                    </select>
                </div>
                <div>
                    <label class="nc-muted nc-fs-sm-block">Description</label>
                    <input id="nc-rule-desc" class="nc-inline-select nc-select-sm" placeholder="Optional description">
                </div>
            </div>
            <div style="margin-bottom:8px">
                <label class="nc-muted" style="font-size:0.8em;display:block;margin-bottom:4px">Conditions</label>
                <div id="nc-rule-conditions"></div>
                <button class="nc-btn" id="nc-rule-add-cond" style="font-size:10px;padding:2px 8px;margin-top:4px"><i class="fas fa-plus"></i> Add Condition</button>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px">
                <button class="nc-btn" id="nc-rule-save" style="padding:4px 16px;font-size:12px"><i class="fas fa-check"></i> Save</button>
                <button class="nc-btn" id="nc-rule-cancel" style="padding:4px 16px;font-size:12px;border-color:rgba(248,113,113,0.3);color:#f87171">Cancel</button>
            </div>
        </div>`;
    }

    function addConditionRow(container, cond) {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:1fr auto 1fr auto;gap:6px;margin-bottom:4px;align-items:center';
        row.innerHTML = `
            <input class="nc-inline-select nc-cond-fact" style="font-size:11px;padding:3px 6px" placeholder="fact (e.g. metric)" value="${shared.escapeHtml(cond?.fact || '')}">
            <select class="nc-inline-select nc-cond-op" style="font-size:11px;padding:3px 4px">
                ${Object.entries(OPERATOR_LABELS).map(([k, v]) => `<option value="${k}" ${cond?.operator === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
            <input class="nc-inline-select nc-cond-value" style="font-size:11px;padding:3px 6px" placeholder="value" value="${shared.escapeHtml(String(cond?.value ?? ''))}">
            <button class="nc-btn nc-cond-remove" style="font-size:10px;padding:2px 6px;color:#f87171"><i class="fas fa-times"></i></button>`;
        row.querySelector('.nc-cond-remove').addEventListener('click', () => row.remove());
        container.appendChild(row);
    }

    function getEditorValues() {
        const condContainer = document.getElementById('nc-rule-conditions');
        const conditions = [];
        condContainer.querySelectorAll('div').forEach(row => {
            const fact = row.querySelector('.nc-cond-fact')?.value?.trim();
            const operator = row.querySelector('.nc-cond-op')?.value;
            let value = row.querySelector('.nc-cond-value')?.value?.trim();
            if (!fact || !value) return;
            const numVal = Number(value);
            if (!isNaN(numVal) && value !== '') value = numVal;
            conditions.push({ fact, operator, value });
        });

        return {
            ruleId: document.getElementById('nc-rule-id').value.trim(),
            name: document.getElementById('nc-rule-name').value.trim(),
            severity: document.getElementById('nc-rule-severity').value,
            description: document.getElementById('nc-rule-desc').value.trim(),
            conditions: { all: conditions },
        };
    }

    function attachAlertHandlers(body) {
        body.querySelectorAll('[data-ack]').forEach(btn => {
            btn.addEventListener('click', async () => {
                await shared.fetchJson(`/api/alerts/${btn.dataset.ack}/acknowledge`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ acknowledgedBy: 'nerve-center' }),
                });
                loadAlerts();
            });
        });
        body.querySelectorAll('[data-resolve]').forEach(btn => {
            btn.addEventListener('click', async () => {
                await shared.fetchJson(`/api/alerts/${btn.dataset.resolve}/resolve`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ resolvedBy: 'nerve-center', method: 'manual' }),
                });
                loadAlerts();
            });
        });
    }

    function attachRuleHandlers(body, rules) {
        const editor = document.getElementById('nc-rule-editor');
        const condContainer = document.getElementById('nc-rule-conditions');
        let editingRuleId = null;

        // Seed defaults link
        const seedLink = document.getElementById('nc-seed-defaults');
        if (seedLink) {
            seedLink.addEventListener('click', async (e) => {
                e.preventDefault();
                await shared.fetchJson('/api/alerts/rules/seed-defaults', { method: 'POST' });
                loadAlerts();
            });
        }

        // Bulk-resolve old alerts
        document.getElementById('nc-bulk-resolve-btn')?.addEventListener('click', async () => {
            if (!confirm('Resolve all active alerts older than 7 days?')) return;
            const result = await shared.fetchJson('/api/alerts/bulk-resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ olderThanDays: 7 }),
            });
            const count = result?.data?.resolved || 0;
            if (count > 0) alert(`Resolved ${count} old alert(s).`);
            loadAlerts();
        });

        // Add rule button
        document.getElementById('nc-add-rule-btn')?.addEventListener('click', () => {
            editingRuleId = null;
            document.getElementById('nc-rule-editor-title').textContent = 'New Alert Rule';
            document.getElementById('nc-rule-id').value = '';
            document.getElementById('nc-rule-id').disabled = false;
            document.getElementById('nc-rule-name').value = '';
            document.getElementById('nc-rule-severity').value = 'warning';
            document.getElementById('nc-rule-desc').value = '';
            condContainer.innerHTML = '';
            addConditionRow(condContainer);
            editor.style.display = 'block';
        });

        // Add condition
        document.getElementById('nc-rule-add-cond')?.addEventListener('click', () => {
            addConditionRow(condContainer);
        });

        // Cancel
        document.getElementById('nc-rule-cancel')?.addEventListener('click', () => {
            editor.style.display = 'none';
        });

        // Save
        document.getElementById('nc-rule-save')?.addEventListener('click', async () => {
            const values = getEditorValues();
            if (!values.ruleId || !values.name) return;

            try {
                if (editingRuleId) {
                    await shared.fetchJson(`/api/alerts/rules/${encodeURIComponent(editingRuleId)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(values),
                    });
                } else {
                    await shared.fetchJson('/api/alerts/rules', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(values),
                    });
                }
                editor.style.display = 'none';
                loadAlerts();
            } catch (err) {
                console.error('[Alerts] Failed to save rule:', err);
            }
        });

        // Toggle enabled/disabled
        body.querySelectorAll('.nc-rule-toggle').forEach(btn => {
            btn.addEventListener('click', async () => {
                const ruleId = btn.dataset.rule;
                const nowEnabled = btn.dataset.enabled === 'true';
                await shared.fetchJson(`/api/alerts/rules/${encodeURIComponent(ruleId)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: !nowEnabled }),
                });
                loadAlerts();
            });
        });

        // Edit
        body.querySelectorAll('.nc-rule-edit').forEach(btn => {
            btn.addEventListener('click', () => {
                const ruleId = btn.dataset.rule;
                const rule = rules.find(r => r.ruleId === ruleId);
                if (!rule) return;

                editingRuleId = ruleId;
                document.getElementById('nc-rule-editor-title').textContent = 'Edit Rule: ' + rule.name;
                document.getElementById('nc-rule-id').value = rule.ruleId;
                document.getElementById('nc-rule-id').disabled = true;
                document.getElementById('nc-rule-name').value = rule.name;
                document.getElementById('nc-rule-severity').value = rule.severity;
                document.getElementById('nc-rule-desc').value = rule.description || '';
                condContainer.innerHTML = '';
                (rule.conditions?.all || []).forEach(c => addConditionRow(condContainer, c));
                if (!rule.conditions?.all?.length) addConditionRow(condContainer);
                editor.style.display = 'block';
            });
        });

        // Delete
        body.querySelectorAll('.nc-rule-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                const ruleId = btn.dataset.rule;
                if (!confirm('Delete rule "' + ruleId + '"?')) return;
                await shared.fetchJson(`/api/alerts/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
                loadAlerts();
            });
        });
    }

    window.NerveCenterAlerts = { loadAlerts };
})();
