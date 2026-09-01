import { fetchBenchmarkTargets, fetchHarnessCampaigns, startHarnessCampaign } from '../benchmark-v2/api.js';
import { esc } from '../benchmark-v2/helpers.js';

let targets = [];

function setCampaignAvailability({ enabled, message }) {
  const select = document.querySelector('#harness-target');
  const prompt = document.querySelector('#harness-prompt');
  const confirm = document.querySelector('#harness-confirm');
  const run = document.querySelector('#harness-run');
  const availability = document.querySelector('#harness-availability');
  const canRun = enabled === true && targets.length > 0;

  if (select) select.disabled = !canRun;
  if (prompt) prompt.disabled = !canRun;
  if (confirm) confirm.disabled = !canRun;
  if (run) run.disabled = !canRun;
  if (availability) {
    availability.dataset.state = canRun ? 'available' : 'unavailable';
    availability.textContent = message;
  }
}

function costApproval(target, prompt) {
  if (target.tier !== 'paid_cloud') return null;
  const pricing = target.pricing || {};
  const inputTokens = Math.max(1, Math.ceil(new TextEncoder().encode(String(prompt || '')).length / 3));
  const outputTokens = 32_000;
  const cost = Number(pricing.callNanodollars || 0)
    + Math.ceil(inputTokens * Number(pricing.inputNanodollarsPerMillion || 0) / 1_000_000)
    + Math.ceil(outputTokens * Number(pricing.outputNanodollarsPerMillion || 0) / 1_000_000);
  if (!window.confirm(`Paid native-agent campaign\n\nWorst-case manual estimate: US$${(cost / 1e9).toFixed(6)}\nOne call, up to ${inputTokens + outputTokens} tokens.\n\nApprove?`)) return false;
  return { confirmed: true, maxCalls: 1, maxTokens: inputTokens + outputTokens, maxCostNanodollars: cost };
}

function renderCampaigns(rows) {
  const el = document.querySelector('#harness-campaigns');
  if (!rows.length) { el.innerHTML = '<p class="harness-note">No native-agent campaign yet.</p>'; return; }
  el.innerHTML = `<table class="harness-table"><thead><tr><th>Target</th><th>Harness</th><th>Profile</th><th>Status</th><th>Usage</th><th>Receipt</th></tr></thead><tbody>${rows.map(row => `
    <tr><td>${esc(row.target?.label || row.target?.model || '—')}<br><small>${esc(row.target?.provider || '')}</small></td>
    <td>${esc(row.target?.harness?.name || '—')} ${esc(row.target?.harness?.version || '')}</td>
    <td><span class="harness-pill">${esc(row.execution_profile)}</span></td><td>${esc(row.status)}</td>
    <td>${Number(row.usage?.totalTokens || 0)} tok · ${Number(row.usage?.durationMs || 0)} ms</td>
    <td title="${esc(row.receipt?.fingerprint || '')}">${esc((row.receipt?.fingerprint || '—').slice(0, 12))}</td></tr>`).join('')}</tbody></table>`;
}

async function refresh() {
  const [catalogResult, campaignsResult] = await Promise.allSettled([fetchBenchmarkTargets(), fetchHarnessCampaigns()]);
  const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value?.data : null;
  targets = (catalog?.targets || []).filter(target => target.mode === 'native_agent' && target.available !== false);
  const select = document.querySelector('#harness-target');
  select.innerHTML = targets.length ? targets.map(target => `<option value="${esc(target.id)}">${esc(target.harness?.name || 'Harness')} · ${esc(target.provider)} · ${esc(target.label || target.model)} · ${target.tier === 'paid_cloud' ? 'paid' : 'free'}</option>`).join('') : '<option value="">No native-agent target available</option>';
  if (catalogResult.status === 'rejected') {
    setCampaignAvailability({ enabled: false, message: `Harness catalog unavailable: ${catalogResult.reason?.message || 'unknown error'}. No provider call is possible.` });
  } else if (catalog?.enabled !== true) {
    setCampaignAvailability({ enabled: false, message: 'Cloud harnesses are disabled in this environment. No provider call is possible.' });
  } else if (!targets.length) {
    setCampaignAvailability({ enabled: false, message: 'The harness broker is enabled, but no attested native-agent target is currently available.' });
  } else {
    setCampaignAvailability({ enabled: true, message: `${targets.length} attested native-agent target${targets.length === 1 ? '' : 's'} available.` });
  }

  if (campaignsResult.status === 'fulfilled') {
    renderCampaigns(campaignsResult.value?.data?.campaigns || []);
  } else {
    const campaigns = document.querySelector('#harness-campaigns');
    if (campaigns) campaigns.innerHTML = `<p class="harness-note">Campaign evidence unavailable: ${esc(campaignsResult.reason?.message || 'unknown error')}</p>`;
  }
}

document.querySelector('#harness-run')?.addEventListener('click', async () => {
  const target = targets.find(item => item.id === document.querySelector('#harness-target')?.value);
  const prompt = document.querySelector('#harness-prompt')?.value || '';
  const confirmed = document.querySelector('#harness-confirm')?.checked === true;
  const status = document.querySelector('#harness-status');
  const output = document.querySelector('#harness-output');
  if (!target || !prompt.trim() || !confirmed) { status.textContent = 'Choose a target, enter a task, and confirm the no-secrets rule.'; return; }
  const paidApproval = costApproval(target, prompt);
  if (paidApproval === false) { status.textContent = 'Paid campaign cancelled; no provider call was made.'; return; }
  status.textContent = 'Running in a disposable workspace…';
  output.hidden = true;
  try {
    const response = await startHarnessCampaign({ target, prompt, confirmation_no_secrets: true, paid_approval: paidApproval });
    status.textContent = 'Campaign completed. Only the public receipt and output fingerprint were persisted.';
    output.textContent = response?.data?.output || '';
    output.hidden = false;
    await refresh();
  } catch (error) { status.textContent = `Campaign failed: ${error.message}`; }
});

refresh().catch(error => {
  targets = [];
  setCampaignAvailability({ enabled: false, message: `Harness UI unavailable: ${error.message}. No provider call is possible.` });
});
