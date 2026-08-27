const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');

describe('Agent X model-evidence progressive disclosure', () => {
  const benchmark = read('views', 'pages', 'benchmark.ejs');
  const results = read('views', 'pages', 'results-explorer.ejs');
  const profiler = read('views', 'pages', 'profiler.ejs');
  const experience = read('public', 'js', 'benchmark-v2', 'experience.js');
  const infrastructure = read('public', 'js', 'benchmark-v2', 'infrastructure.js');
  const resultsJs = read('public', 'js', 'results-explorer.js');
  const leaderboardJs = read('public', 'js', 'leaderboard-v2', 'index.js');
  const profilerExperience = read('public', 'js', 'model-profiler', 'experience.js');
  const css = read('public', 'css', 'model-evidence-experience.css');
  const profilerCss = read('public', 'css', 'profiler-experience.css');

  test('leads with a human decision and three clear actions', () => {
    expect(benchmark).toContain('Find the best model for the job.');
    expect(benchmark).toContain('Set up a comparison');
    expect(benchmark).toContain('See ranked models');
    expect(benchmark).toContain('Inspect evidence');
    expect(benchmark).toContain('evaluation-readiness-label');
  });

  test('keeps the full engine room inside one expert-lab door', () => {
    expect(benchmark).toContain('<details id="benchmark-cockpit"');
    expect(benchmark).toContain('<strong>Take the controls</strong>');
    const simpleSurface = benchmark.split('<details id="benchmark-cockpit"')[0];
    expect(simpleSurface).not.toMatch(/Judge Host|Multi-Judge|Thinking Policy|prompt-counter/);
    expect(benchmark).toMatch(/Execution host[\s\S]*Judge[\s\S]*test depth[\s\S]*Live rankings/i);
    expect(experience).toContain("surface.setAttribute('inert', '')");
    expect(experience).toContain("surface.setAttribute('aria-hidden', 'true')");
    expect(experience).toContain("els.cockpit.addEventListener('toggle', syncCockpitAccessibility)");
  });

  test('turns runtime and profiling prerequisites into actionable labelled states', () => {
    expect(experience).toContain("setReadiness('error', 'No model runtime available'");
    expect(experience).toContain("setReadiness('unknown', 'Model runtime status is unknown'");
    expect(experience).toContain("setReadiness('warn', 'Host needs a quick profile'");
    expect(experience).toContain("setReadiness('ok', 'Ready to compare'");
    expect(experience).toContain("setPrimary('Prepare the host'");
    expect(infrastructure).toContain('h.status = d.status || h.status');
    expect(infrastructure).not.toContain('if (!_isOnline(h)) return;');
    expect(infrastructure).toContain("_perfCell('Not Tested'");
  });

  test('never renders decorative empty evidence charts', () => {
    expect(results).toContain('id="results-empty-experience"');
    expect(results).toContain('No evaluation evidence yet');
    expect(results).toContain('id="results-data-workbench"');
    expect(resultsJs).toContain('const hasEvidence = paginationState.total > 0');
    expect(resultsJs).toContain('setExperienceSurfaceHidden(workbench, !hasEvidence)');
    expect(resultsJs).toContain('element.inert = hidden');
    expect(leaderboardJs).toContain('hideInactiveSurface(filterBar)');
    expect(leaderboardJs).toContain('element.inert = true');
    expect(leaderboardJs).toContain('<h1>No ranked models yet</h1>');
  });

  test('preserves responsive, focus and reduced-motion behavior', () => {
    expect(css).toContain('@media (max-width: 600px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
    expect(experience).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')");
  });

  test('turns profiler prerequisites into one guided, non-destructive preparation path', () => {
    const simpleDepth = profiler.split('<details id="profiler-cockpit"')[0];
    expect(simpleDepth).toContain('Prepare trustworthy model comparisons.');
    expect(simpleDepth).toContain('Prepare a host');
    expect(simpleDepth).toContain('Profile exact models');
    expect(simpleDepth).not.toMatch(/TTFT|VRAM|Baseline model|Profile All on Host/);
    expect(profiler).toContain('<strong>Take the controls</strong>');
    expect(profiler).toContain('id="mp-hosts-section"');
    expect(profiler).toContain('id="mp-models-section"');
    expect(profilerExperience).toContain('surface.inert = !cockpit.open');
    expect(profilerExperience).toMatch(/setStatus\('attention', 'A host baseline is required',[\s\S]*'fa-circle-info'\)/);
    expect(profilerExperience).toContain("setStatus('ready', 'Prepared for comparison'");
    expect(profilerExperience).not.toMatch(/\.click\(\).*Baseline|Baseline.*\.click\(\)/);
    expect(profilerCss).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
