(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.ChatModelReadiness = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STAGE_RANK = {
    available: 0,
    profiled: 1,
    benchmarked: 2
  };

  function normalizeStage(stage) {
    var normalized = String(stage || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(STAGE_RANK, normalized) ? normalized : 'available';
  }

  function getStageRank(modelOrStage) {
    var stage = modelOrStage && typeof modelOrStage === 'object'
      ? modelOrStage.readiness && modelOrStage.readiness.stage
      : modelOrStage;
    return STAGE_RANK[normalizeStage(stage)] || 0;
  }

  function isProfiledReady(modelOrStage) {
    if (modelOrStage && typeof modelOrStage === 'object') {
      var readiness = modelOrStage.readiness || modelOrStage;
      return ['standard', 'full'].indexOf(readiness.profileDepth) !== -1
        && readiness.benchmarkQualified === true
        && readiness.stale !== true;
    }
    return false;
  }

  function getReadinessMeta(model, requireProfiledModels) {
    var readiness = model && model.readiness ? model.readiness : {};
    var stage = normalizeStage(readiness.stage);
    var ready = isProfiledReady(readiness);
    var blocked = !!requireProfiledModels && !ready;
    var label = '';
    var tip = '';

    if (stage === 'benchmarked') {
      label = ready ? 'Benchmarked' : 'Benchmark evidence stale';
      tip = ready ? 'Ready for chat and routing.' : 'Re-profile the exact installed artifact before use.';
    } else if (stage === 'profiled') {
      label = ready ? 'Profiled' : (readiness.stale ? 'Profile stale' : 'Quick profile only');
      tip = ready
        ? 'Current standard/full profile is bound to this installed artifact.'
        : 'A current standard or full exact-artifact profile is required.';
    } else {
      label = blocked ? 'Not profiled - blocked' : 'Not profiled';
      tip = blocked
        ? 'Blocked because REQUIRE_PROFILED_MODELS is enabled.'
        : 'Visible for compatibility, but benchmark profiling has not cleared it yet.';
    }

    return {
      stage: stage,
      ready: ready,
      blocked: blocked,
      label: label,
      tip: tip
    };
  }

  function buildOptionLabel(model, requireProfiledModels) {
    var meta = getReadinessMeta(model, requireProfiledModels);
    var base = model.displayName || model.name || '';
    if (!base) return meta.label;
    if (meta.stage === 'benchmarked') return base;
    return base + ' - ' + meta.label;
  }

  function compareForDropdown(left, right) {
    var rankDiff = getStageRank(right) - getStageRank(left);
    if (rankDiff !== 0) return rankDiff;

    var leftName = String((left && (left.displayName || left.name)) || '');
    var rightName = String((right && (right.displayName || right.name)) || '');
    return leftName.localeCompare(rightName);
  }

  function applyOptionState(optionEl, model, requireProfiledModels) {
    var meta = getReadinessMeta(model, requireProfiledModels);
    optionEl.textContent = buildOptionLabel(model, requireProfiledModels);
    optionEl.title = meta.tip;
    optionEl.disabled = meta.blocked;
    optionEl.setAttribute('data-readiness-stage', meta.stage);
    optionEl.setAttribute('data-chat-ready', meta.ready ? 'true' : 'false');
    optionEl.setAttribute('data-chat-allowed', meta.blocked ? 'false' : 'true');
  }

  return {
    normalizeStage: normalizeStage,
    getStageRank: getStageRank,
    isProfiledReady: isProfiledReady,
    getReadinessMeta: getReadinessMeta,
    buildOptionLabel: buildOptionLabel,
    compareForDropdown: compareForDropdown,
    applyOptionState: applyOptionState
  };
});
