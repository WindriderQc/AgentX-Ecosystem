import { fetchActiveProfiles, fetchActiveProfileQueues } from './api.js';

export async function fetchActiveProfilingState() {
    const [profilesRes, queuesRes] = await Promise.all([
        fetchActiveProfiles().catch(() => null),
        fetchActiveProfileQueues().catch(() => null),
    ]);

    return {
        profiles: _activeList(profilesRes),
        queues: _activeList(queuesRes),
    };
}

export function findProfilingForHost(hostOrUrl, state = {}) {
    const hostId = typeof hostOrUrl === 'object' ? String(hostOrUrl?.hostId || '') : '';
    const hostUrl = typeof hostOrUrl === 'object'
        ? _normUrl(hostOrUrl?.hostUrl || hostOrUrl?.url || '')
        : _normUrl(hostOrUrl || '');

    const matches = [];
    for (const profile of state.profiles || []) {
        if (_matches(hostId, hostUrl, profile)) matches.push({ ...profile, type: profile.type || 'profile' });
    }
    for (const queue of state.queues || []) {
        if (_matches(hostId, hostUrl, queue)) matches.push({ ...queue, type: queue.type || 'profile-host' });
    }
    return matches;
}

export function formatProfilingLockout(matches = []) {
    const first = matches[0];
    if (!first) return '';
    if (first.type === 'profile-host') {
        const model = first.currentModel ? `: ${first.currentModel}` : '';
        const progress = Number.isFinite(Number(first.currentIndex)) && Number.isFinite(Number(first.total))
            ? ` (${Number(first.currentIndex) + 1}/${Number(first.total)})`
            : '';
        return `Profiling queue${progress}${model}`;
    }
    const model = first.modelName ? `: ${first.modelName}` : '';
    const step = first.currentStep ? ` (${first.currentStep})` : '';
    return `Profiling${model}${step}`;
}

function _activeList(res) {
    const data = res?.data || res || {};
    return Array.isArray(data.active) ? data.active : [];
}

function _matches(hostId, hostUrl, item) {
    const itemHostId = String(item?.hostId || '');
    const itemHostUrl = _normUrl(item?.hostUrl || '');
    return !!(
        (hostId && itemHostId && hostId === itemHostId) ||
        (hostUrl && itemHostUrl && hostUrl === itemHostUrl)
    );
}

function _normUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}
