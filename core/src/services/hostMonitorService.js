const Host = require('../../models/Host');
const HostMetricsSnapshot = require('../../models/HostMetricsSnapshot');
const logger = require('../../config/logger');
const { getConfiguredHosts, parseHostIp } = require('../helpers/ollamaHostConfig');

const OFFLINE_THRESHOLD_MS = 120000;      // 2 minutes without heartbeat → offline
const SNAPSHOT_INTERVAL_MS = 60000;       // store one history snapshot per 60s
const STALE_CHECK_INTERVAL_MS = 30000;    // check for stale hosts every 30s
const DEGRADED_THRESHOLDS = { cpu: 90, memory: 90, disk: 95 };

class HostMonitorService {
  constructor() {
    this._lastSnapshotTime = new Map(); // hostId → lastSnapshotTimestamp
    this._staleInterval = null;
  }

  /** Start background stale-host checker */
  start() {
    if (this._staleInterval) return;
    this._staleInterval = setInterval(() => this._markStaleHosts(), STALE_CHECK_INTERVAL_MS);
    logger.info('HostMonitorService started');
  }

  stop() {
    if (this._staleInterval) {
      clearInterval(this._staleInterval);
      this._staleInterval = null;
    }
  }

  /**
   * Process an incoming heartbeat/report from a host agent.
   * Upserts the Host doc and optionally inserts a time-series snapshot.
   */
  async processReport(report) {
    const { hostId } = report;
    if (!hostId) throw new Error('hostId is required');

    const status = this._computeStatus(report);
    const now = new Date();
    const inferredOllamaLink = this._inferOllamaLink(report);

    const update = {
      hostname: report.hostname || hostId,
      platform: report.platform || 'unknown',
      distro: report.distro || '',
      kernel: report.kernel || '',
      arch: report.arch || '',
      ip: report.ip || '',
      agentVersion: report.agentVersion || '1.0.0',
      status,
      lastSeen: now,
      cpu: report.cpu || {},
      memory: report.memory || {},
      gpus: report.gpus || [],
      disks: report.disks || [],
      network: report.network || {},
      topProcessesCpu: report.topProcessesCpu || [],
      topProcessesMem: report.topProcessesMem || [],
      uptime: report.uptime || 0,
      ...(report.ollamaEnv ? { ollamaEnv: report.ollamaEnv } : {}),
      ...(report.nvidia ? { nvidia: report.nvidia } : {}),
      ...(report.swap ? { swap: report.swap } : {}),
      ...(report.ollamaService ? { ollamaService: report.ollamaService } : {}),
      ...inferredOllamaLink
    };

    const host = await Host.findOneAndUpdate(
      { hostId },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Downsample: only store a snapshot if enough time has passed
    await this._maybeStoreSnapshot(hostId, report, now);

    return host;
  }

  /** Get all hosts (with optional status filter) */
  async getAllHosts(statusFilter) {
    const query = statusFilter ? { status: statusFilter } : {};
    return Host.find(query).sort({ hostname: 1 }).lean();
  }

  /** Get a single host by hostId */
  async getHost(hostId) {
    return Host.findOne({ hostId }).lean();
  }

  /** Get time-series snapshots for a host */
  async getHostHistory(hostId, { from, to, limit = 500 } = {}) {
    const query = { hostId };
    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = new Date(from);
      if (to) query.timestamp.$lte = new Date(to);
    }
    return HostMetricsSnapshot.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
  }

  /** Update host config fields (tags, ollamaUrl, hostname, ollamaHostKey) */
  async updateHost(hostId, fields) {
    const allowed = {};
    if (fields.tags !== undefined) allowed.tags = fields.tags;
    if (fields.ollamaUrl !== undefined) allowed.ollamaUrl = fields.ollamaUrl;
    if (fields.hostname !== undefined) allowed.hostname = fields.hostname;
    if (fields.ollamaHostKey !== undefined) allowed.ollamaHostKey = fields.ollamaHostKey;

    if (Object.keys(allowed).length === 0) return null;
    return Host.findOneAndUpdate({ hostId }, { $set: allowed }, { new: true }).lean();
  }

  /** Remove a host and its history */
  async removeHost(hostId) {
    const [host] = await Promise.all([
      Host.findOneAndDelete({ hostId }),
      HostMetricsSnapshot.deleteMany({ hostId })
    ]);
    return host;
  }

  /** Get aggregate summary across all hosts */
  async getSummary() {
    const hosts = await Host.find({}).lean();
    const totalHosts = hosts.length;
    const online = hosts.filter(h => h.status === 'online').length;
    const offline = hosts.filter(h => h.status === 'offline').length;
    const degraded = hosts.filter(h => h.status === 'degraded').length;

    const avgCpu = totalHosts > 0
      ? hosts.reduce((sum, h) => sum + (h.cpu?.usage || 0), 0) / totalHosts
      : 0;
    const avgMemory = totalHosts > 0
      ? hosts.reduce((sum, h) => sum + (h.memory?.usagePercent || 0), 0) / totalHosts
      : 0;

    const totalGpus = hosts.reduce((sum, h) => sum + (h.gpus?.length || 0), 0);
    const totalVramMiB = hosts.reduce((sum, h) =>
      sum + (h.gpus || []).reduce((gs, g) => gs + (g.vramTotal || 0), 0), 0);

    return {
      totalHosts, online, offline, degraded,
      avgCpu: Math.round(avgCpu * 10) / 10,
      avgMemory: Math.round(avgMemory * 10) / 10,
      totalGpus,
      totalVramMiB
    };
  }

  // ─── Private ──────────────────────────────────────────────

  _computeStatus(report) {
    const cpuUsage = report.cpu?.usage || 0;
    const memUsage = report.memory?.usagePercent || 0;
    const maxDisk = (report.disks || []).reduce((max, d) => Math.max(max, d.usagePercent || 0), 0);

    if (cpuUsage >= DEGRADED_THRESHOLDS.cpu ||
        memUsage >= DEGRADED_THRESHOLDS.memory ||
        maxDisk >= DEGRADED_THRESHOLDS.disk) {
      return 'degraded';
    }
    return 'online';
  }

  async _maybeStoreSnapshot(hostId, report, now) {
    const lastTs = this._lastSnapshotTime.get(hostId) || 0;
    if (now.getTime() - lastTs < SNAPSHOT_INTERVAL_MS) return;

    try {
      const maxDisk = (report.disks || []).reduce((max, d) => Math.max(max, d.usagePercent || 0), 0);
      const netInterfaces = report.network?.interfaces || [];
      const totalBytesIn = netInterfaces.reduce((s, n) => s + (n.bytesIn || 0), 0);
      const totalBytesOut = netInterfaces.reduce((s, n) => s + (n.bytesOut || 0), 0);

      await HostMetricsSnapshot.create({
        hostId,
        timestamp: now,
        cpu: {
          usage: report.cpu?.usage || 0,
          temperature: report.cpu?.temperature || null
        },
        memory: {
          usagePercent: report.memory?.usagePercent || 0,
          used: report.memory?.used || 0
        },
        gpus: (report.gpus || []).map(g => ({
          // Use ?? (not ||) so a genuine 0 reading is preserved, not coerced to
          // the fallback. A truly idle GPU reports utilization 0 — `0 || null`
          // would store null ("no data"), corrupting p50/p95 utilization stats.
          index: g.index ?? 0,
          vramUsed: g.vramUsed ?? 0,
          temperature: g.temperature ?? null,
          utilization: g.utilization ?? null
        })),
        diskMaxUsagePercent: maxDisk,
        networkBytesIn: totalBytesIn,
        networkBytesOut: totalBytesOut
      });

      this._lastSnapshotTime.set(hostId, now.getTime());
    } catch (err) {
      logger.warn('Failed to store host metrics snapshot', { hostId, error: err.message });
    }
  }

  async _markStaleHosts() {
    try {
      const count = await Host.markStaleOffline(OFFLINE_THRESHOLD_MS);
      if (count > 0) {
        logger.info(`Marked ${count} host(s) as offline (stale heartbeat)`);
      }
    } catch (err) {
      logger.warn('Failed to mark stale hosts', { error: err.message });
    }
  }

  _inferOllamaLink(report) {
    const reportIp = String(report.ip || '').trim().toLowerCase();
    const reportHostname = String(report.hostname || '').trim().toLowerCase();
    const reportHostId = String(report.hostId || '').trim().toLowerCase();

    const configured = getConfiguredHosts();

    // IP is the host's true identity — match it across ALL configured hosts
    // first. Otherwise a role-style hostId (e.g. a Host Gamma agent reporting
    // HOST_ID=primary) can collide with another host's configured key and get
    // linked to the wrong Ollama slot before the loop ever reaches the entry
    // whose IP actually matches. Hostname/hostId are only a fallback.
    const byIp = configured.find((host) => {
      const configuredIp = String(parseHostIp(host.url) || '').trim().toLowerCase();
      return reportIp && configuredIp && reportIp === configuredIp;
    });

    const match = byIp || configured.find((host) => {
      const configuredName = String(host.name || '').trim().toLowerCase();
      const configuredKey = String(host.id || '').trim().toLowerCase();
      const matchesByHostname = reportHostname && configuredName && reportHostname === configuredName;
      const matchesByHostId = reportHostId && (
        (configuredName && reportHostId === configuredName) ||
        (configuredKey && reportHostId === configuredKey)
      );
      return matchesByHostname || matchesByHostId;
    });

    return match ? { ollamaHostKey: match.id, ollamaUrl: match.url } : {};
  }
}

module.exports = new HostMonitorService();
