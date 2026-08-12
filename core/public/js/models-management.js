/**
 * Model Management Logic
 * Handles CRUD, status changes, and add source workflows.
 */

class ModelManager {
    constructor(unifiedModels) {
        this.unifiedModels = unifiedModels;
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Add Source Modal
        const addBtn = document.getElementById('addModelBtn') || document.getElementById('openAddSourceBtn');
        const modal = document.getElementById('addSourceModal');
        const closeBtns = modal.querySelectorAll('.close-modal');
        const tabBtns = modal.querySelectorAll('.tab-btn');

        addBtn?.addEventListener('click', () => {
            this.populatePullHosts();
            modal.classList.add('active');
        });

        closeBtns.forEach(btn => btn.addEventListener('click', () => {
            modal.classList.remove('active');
            this.resetPullForm();
        }));

        // Tab Switching
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                modal.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

                btn.classList.add('active');
                document.getElementById(btn.dataset.tab).classList.add('active');
            });
        });

        // Pull Action
        document.getElementById('btnPull')?.addEventListener('click', () => this.handlePull());

    }

    populatePullHosts() {
        const select = document.getElementById('pullModelHost');
        if (!select) return;
        const hosts = this.unifiedModels.sources?.ollama?.hosts || [];
        const activeFilter = document.getElementById('hostSelect')?.value;

        select.innerHTML = hosts.length
            ? hosts.map(host => `<option value="${this.escape(host.url)}">${this.escape(host.name || host.url)}</option>`).join('')
            : '<option value="">No configured Ollama hosts</option>';

        if (hosts.some(host => host.url === activeFilter)) select.value = activeFilter;
        select.disabled = hosts.length === 0;
    }

    escape(value) {
        return window.AgentXUtils.escapeHtml(String(value || ''));
    }

    modelTarget(model) {
        return {
            name: model.deployment?.resolvedName || model.name,
            host: model.source?.url || model.deployment?.ollamaHost || '',
            hostName: model.source?.hostName || model.source?.url || 'selected host'
        };
    }

    async readResponse(res) {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.status === 'error') {
            throw new Error(data.message || data.error || `Request failed (${res.status})`);
        }
        return data;
    }

    async handlePull() {
        const input = document.getElementById('pullModelName');
        const hostSelect = document.getElementById('pullModelHost');
        const button = document.getElementById('btnPull');
        const progress = document.getElementById('pullProgress');
        const name = input.value.trim();
        const host = hostSelect?.value;
        const hostName = hostSelect?.selectedOptions?.[0]?.textContent?.trim() || host;

        if (!name) return alert('Please enter a model name');
        if (!host) return alert('Please select a target Ollama host');

        input.disabled = true;
        hostSelect.disabled = true;
        if (button) button.disabled = true;
        progress.classList.remove('hidden');
        progress.querySelector('.status-text').innerText = `Pulling ${name} to ${hostName}. This can take several minutes...`;

        try {
            const res = await fetch('/api/models/ollama/pull', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, host })
            });
            await this.readResponse(res);
            progress.querySelector('.status-text').innerText = `Pulled ${name} to ${hostName} successfully.`;
            await this.unifiedModels.fetchModels();
            window.Toast?.success?.(`${name} is now installed on ${hostName}`);
            setTimeout(() => {
                document.getElementById('addSourceModal').classList.remove('active');
                this.resetPullForm();
            }, 2500);
        } catch (err) {
            progress.querySelector('.status-text').innerText = `Error: ${err.message}`;
            input.disabled = false;
            hostSelect.disabled = false;
            if (button) button.disabled = false;
        }
    }

    resetPullForm() {
        const input = document.getElementById('pullModelName');
        const hostSelect = document.getElementById('pullModelHost');
        const button = document.getElementById('btnPull');
        const progress = document.getElementById('pullProgress');
        if(input) { input.value = ''; input.disabled = false; }
        if(hostSelect) hostSelect.disabled = false;
        if(button) button.disabled = false;
        if(progress) progress.classList.add('hidden');
    }

    async deleteModel(model) {
        const target = this.modelTarget(model);
        if (!target.host) return alert('This model does not have a specific Ollama host.');
        if (!confirm(`Delete ${target.name} from ${target.hostName}? This cannot be undone.`)) return;

        try {
            if (model.source?.type === 'ollama-host' || model.provider === 'ollama') {
                const endpoint = `/api/models/ollama/${encodeURIComponent(target.name)}?host=${encodeURIComponent(target.host)}`;
                const res = await fetch(endpoint, { method: 'DELETE' });
                await this.readResponse(res);
            } else {
                alert('Deletion not supported for this provider yet.');
                return;
            }

            await this.unifiedModels.fetchModels();
            window.Toast?.success?.(`Deleted ${target.name} from ${target.hostName}`);
        } catch (err) {
            console.error(err);
            alert(`Delete failed: ${err.message}`);
        }
    }

    async startModel(model) {
        return this.setRuntimeState(model, 'start');
    }

    async stopModel(model) {
        return this.setRuntimeState(model, 'stop');
    }

    async setRuntimeState(model, action) {
        if (model.provider !== 'ollama' && model.source?.type !== 'ollama-host') {
            return alert('Runtime controls are only available for Ollama models.');
        }
        const target = this.modelTarget(model);
        if (!target.host) return alert('This model does not have a specific Ollama host.');

        try {
            window.Toast?.info?.(`${action === 'start' ? 'Loading' : 'Unloading'} ${target.name} on ${target.hostName}...`);
            const res = await fetch(`/api/models/ollama/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: target.name, host: target.host })
            });
            await this.readResponse(res);
            await this.unifiedModels.fetchLiveState();
            window.Toast?.success?.(`${target.name} ${action === 'start' ? 'loaded on' : 'unloaded from'} ${target.hostName}`);
        } catch (err) {
            console.error(err);
            alert(`${action === 'start' ? 'Start' : 'Stop'} failed: ${err.message}`);
        }
    }

    async testModel(model) {
        // Quick test modal or redirect to chat
        // For Phase 2, redirecting to chat with the model selected is a good "Test".
        // Or opening a mini-modal.
        // Let's use startChat since it's robust.
        const target = this.modelTarget(model);
        const params = new URLSearchParams({ model: target.name });
        if (target.host) params.set('host', target.host);
        window.location.href = `/chat?${params.toString()}`;
    }
}

// Attach to window for easy access
window.ModelManager = ModelManager;
