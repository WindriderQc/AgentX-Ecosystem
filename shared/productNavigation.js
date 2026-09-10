'use strict';

const { demoSurfaceDisabled } = require('./agentxRuntimeProfile');

// One destination catalogue for the home and every service navigation.
// Runtime availability is independent of how much UI the user expands.
function buildProductNavigation({
  service = 'core', activePage = '', publicUrls = {}, agentxProfile = 'full',
  trustedRuntimeNavItems = []
} = {}) {

  /**
   * Server-rendered navigation bar.
   * Replaces the client-side nav.js (injectNav).
   *
   * Locals:
   *   service    — 'core' | 'benchmark' | 'rag'
   *   activePage — slug of the current page for highlight
   *   publicUrls — normalized browser-reachable service authorities
   *   trustedRuntimeNavItems — validated same-origin launchers from trusted extensions
   */
  const cleanBase = (value) => String(value || '').replace(/\/+$/, '');
  const urls = typeof publicUrls === 'object' && publicUrls ? publicUrls : {};
  const configuredBase = (name) => cleanBase(urls[name]);
  // Same-service links stay relative, preserving whichever HTTP/HTTPS front
  // door rendered the page. Only cross-service hops use public URL authority.
  const coreBase = service === 'core' ? '' : configuredBase('core');
  const benchBase = service === 'benchmark' ? '' : configuredBase('benchmark');
  const ragBase = service === 'rag' ? '' : configuredBase('rag');
  /* Retired pages that fold into nerve-center */
  const retiredToNerveCenter = [
    'operations', 'hosts', 'cluster', 'alerts',
    'dashboard', 'alert-analytics', 'hardware-matrix'
  ];
  const remapped = { 'cost-tracking': 'analytics' };

  const raw = typeof activePage === 'string' ? activePage : '';
  const effectiveActive = remapped[raw]
    || (retiredToNerveCenter.includes(raw) ? 'nerve-center' : raw);

  /* Product-oriented information architecture. The portal remains the full
     service map; this navigation optimizes common operator journeys. */
  const fullNavItems = [
    { label: 'Chat', href: coreBase + '/playground', icon: 'fa-comments', id: 'playground', primary: true },
    { label: 'Compare models', href: benchBase + '/', icon: 'fa-trophy', id: 'benchmark' },
    {
      label: 'Work', icon: 'fa-list-check', id: 'work-group',
      children: [
        { label: 'Pipeline',  href: coreBase + '/pipeline',  icon: 'fa-list-check', id: 'pipeline' },
        { label: 'Agent Ops', href: coreBase + '/agent-ops', icon: 'fa-users-gear', id: 'agent-ops' }
      ]
    },
    {
      label: 'Operate', icon: 'fa-gauge-high', id: 'operate-group',
      children: [
        { label: 'Nerve Center', href: coreBase + '/nerve-center',     icon: 'fa-brain',          id: 'nerve-center' },
        { label: 'Schedule',     href: coreBase + '/cluster-schedule', icon: 'fa-calendar-alt',   id: 'cluster-schedule' },
        { label: 'Models',       href: coreBase + '/models',           icon: 'fa-cubes',          id: 'models' },
        { label: 'Activity',     href: coreBase + '/analytics',        icon: 'fa-chart-line',     id: 'analytics' },
        { section: 'Administration' },
        { label: 'Performance',  href: coreBase + '/performance',      icon: 'fa-tachometer-alt', id: 'performance' },
        { label: 'Backup',       href: coreBase + '/backup',           icon: 'fa-box-archive',    id: 'backup' },
        { label: 'Keyboard Shortcuts', icon: 'fa-keyboard',            id: 'keyboard-shortcuts',  action: 'show-shortcuts' }
      ]
    },
    {
      label: 'Knowledge', icon: 'fa-book', id: 'knowledge-group',
      children: [
        { label: 'Add knowledge', href: ragBase + '/upload',    icon: 'fa-upload',           id: 'rag-upload' },
        { label: 'Ask your knowledge', href: ragBase + '/search', icon: 'fa-magnifying-glass', id: 'rag-search' },
        { label: 'Browse sources', href: ragBase + '/documents', icon: 'fa-file-lines',      id: 'rag-documents' },
        { label: 'Knowledge overview', href: ragBase + '/',    icon: 'fa-gauge',            id: 'rag' },
        { label: 'Maintenance',   href: ragBase + '/maintenance', icon: 'fa-screwdriver-wrench', id: 'rag-maintenance' },
        { section: 'Agent memory' },
        { label: 'Memory Review', href: coreBase + '/memory-review', icon: 'fa-brain', id: 'memory-review' }
      ]
    },
    {
      label: 'Labs', icon: 'fa-flask', id: 'labs-group',
      children: [
        { section: 'Evaluation' },
        { label: 'Leaderboard',      href: benchBase + '/leaderboard',     icon: 'fa-medal',      id: 'leaderboard' },
        { label: 'Harnesses',        href: benchBase + '/harnesses',       icon: 'fa-cloud',      id: 'harnesses' },
        { label: 'Profiler',         href: benchBase + '/profiler',        icon: 'fa-microscope', id: 'profiler' },
        { label: 'Courthouse',       href: benchBase + '/courthouse',      icon: 'fa-gavel',      id: 'courthouse' },
        { label: 'Results Explorer', href: benchBase + '/results-explorer', icon: 'fa-table-list', id: 'results-explorer' },
        { label: 'Efficiency Map',   href: benchBase + '/efficiency-map',  icon: 'fa-bolt',       id: 'efficiency-map' },
        { section: 'Experimental' },
        { label: 'Council',          href: coreBase + '/council',          icon: 'fa-users',           id: 'council' },
        { label: 'Prompts',          href: coreBase + '/prompts',          icon: 'fa-pen-fancy',       id: 'prompts' },
        /* Frozen history stays reachable at its stable route, out of the
           daily journey: Pipeline is the execution authority. */
        { section: 'History & reference' },
        { label: 'Planning · frozen', href: coreBase + '/planning',        icon: 'fa-snowflake',       id: 'planning',
          description: 'Historical strategy and evidence reference. Frozen: current delivery lives in Pipeline.' }
      ]
    }
  ];

  const runtimeNavItems = Array.isArray(trustedRuntimeNavItems)
    ? trustedRuntimeNavItems
    : [];
  /* External runtimes are supplied by the deployment through trusted
     extensions and validated by Product. They render identically on every
     Product service: a launcher is always a Core route, so non-Core services
     prefix it with the configured Core authority. Each launcher leaves the
     Product surface, so it opens in its own tab and names its provider. */
  if (runtimeNavItems.length) {
    const operateGroup = fullNavItems.find(function(item) { return item.id === 'operate-group'; });
    operateGroup.children.push(
      { section: 'External runtimes' },
      ...runtimeNavItems.map(function(item) {
        return {
          id: item.id,
          label: item.label,
          icon: item.icon,
          href: coreBase + item.href,
          external: true,
          owner: item.owner || null,
          description: item.description || null
        };
      })
    );
  }

  const demoProfile = agentxProfile === 'demo';
  const available = item => !demoProfile || (!item.external && (
    !item.href || !item.href.startsWith(coreBase + '/') ||
    !demoSurfaceDisabled(item.href.slice(coreBase.length))
  ));
  const navItems = fullNavItems.map(item => {
    if (!item.children) return item;
    const children = item.children.filter(available)
      .filter((child, index, all) => !child.section || (all[index + 1] && !all[index + 1].section));
    return { ...item, children };
  }).filter(item => !item.children || item.children.length);
  const brandHref = coreBase + '/portal/';
  const brandTitle = 'Open Agent X home';

  function isActive(id) { return id === effectiveActive; }
  function isChildActive(children) {
    return children.some(function(c) { return c.id && isActive(c.id); });
  }

  return { navItems, brandHref, brandTitle, isActive, isChildActive };
}

module.exports = { buildProductNavigation };
