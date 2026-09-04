'use strict';

const express = require('express');
const router = express.Router();
const HostProfile = require('../../models/HostProfile');
const ModelProfile = require('../../models/ModelProfile');
const performanceProfiles = require('../../src/services/profiler/modelPerformanceProfileService');
const contextProfiles = require('../../src/services/modelContextProfileService');
const { resolveRuntimeArtifactReceipt } = require('../../src/services/profiler/artifactIdentityService');
const toolQualifications = require('../../src/services/qualification/toolCapabilityQualificationService');
const ModelPerformanceProfile = require('../../models/ModelPerformanceProfile');
const {
  projectReadinessEntry,
  projectReadinessProfiles
} = require('../../src/services/profiler/profilerReadinessProjectionService');
const { normalizeHostUrl } = require('../../../shared/artifactIdentity');
const { normalizeModelTag } = require('../../../shared/modelNames');

function mapToObject(value) {
  return value instanceof Map ? Object.fromEntries(value) : (value || {});
}

function serializeModelProfile(profile) {
  if (!profile) return null;
  return {
    name: profile.name,
    capabilities: profile.capabilities || {},
    thinkingProfiles: mapToObject(profile.thinkingProfiles),
    readiness: mapToObject(profile.readiness),
    updatedAt: profile.updatedAt || null
  };
}

function toolIdentityFromQuery(modelName, hostUrl, query = {}) {
  const identity = {
    modelName,
    hostUrl,
    hostId: String(query.hostId || '').trim(),
    artifactDigest: String(query.artifactDigest || '').trim(),
    runtimeFingerprint: String(query.runtimeFingerprint || '').trim()
  };
  return identity.hostId && identity.artifactDigest && identity.runtimeFingerprint
    ? identity
    : null;
}

function missingToolEvidence() {
  return {
    contract: toolQualifications.QUALIFICATION_SCHEMA_VERSION,
    state: 'unknown',
    supported: null,
    qualified: false,
    reasons: ['artifact_identity_required'],
    expected: toolQualifications.currentEvidenceContract(),
    evidence: null
  };
}

router.get('/readiness', async (_req, res) => {
  try {
    const profiles = await ModelProfile.find({})
      .select({ name: 1, readiness: 1, _id: 0 })
      .lean();
    const projected = await projectReadinessProfiles(profiles);
    res.json({
      status: 'success',
      data: {
        profiles: projected
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

router.get('/host', async (req, res) => {
  try {
    const hostUrl = normalizeHostUrl(req.query.hostUrl);
    if (!hostUrl) {
      return res.status(400).json({ status: 'error', error: 'hostUrl is required' });
    }
    const hostProfile = await HostProfile.findOne({ hostUrl })
      .select('hostId hostUrl displayName gpu ollama cpu')
      .lean();
    return res.json({ status: 'success', data: { hostProfile: hostProfile || null } });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

router.get('/inference/:modelName', async (req, res) => {
  try {
    const modelName = normalizeModelTag(req.params.modelName);
    const hostUrl = normalizeHostUrl(req.query.hostUrl);
    if (!modelName || !hostUrl) {
      return res.status(400).json({ status: 'error', error: 'modelName and hostUrl are required' });
    }
    const toolIdentity = toolIdentityFromQuery(modelName, hostUrl, req.query);
    const [hostProfile, modelProfile, toolQualification] = await Promise.all([
      HostProfile.findOne({ hostUrl })
        .select('hostId hostUrl displayName gpu ollama cpu')
        .lean(),
      ModelProfile.findOne({ name: modelName })
        .select('name capabilities thinkingProfiles readiness updatedAt')
        .lean(),
      toolIdentity
        ? toolQualifications.resolveQualification(toolIdentity)
        : missingToolEvidence()
    ]);
    let serializedModelProfile = serializeModelProfile(modelProfile);
    const hostId = hostProfile?.hostId || null;
    const rawReadiness = hostId ? mapToObject(modelProfile?.readiness)?.[hostId] : null;
    if (serializedModelProfile && hostId && rawReadiness) {
      const evidence = rawReadiness.evidenceId
        ? await ModelPerformanceProfile.findOne({ _id: rawReadiness.evidenceId }).lean()
        : null;
      const projected = await projectReadinessEntry(
        modelName,
        hostId,
        rawReadiness,
        new Map(evidence ? [[String(evidence._id), evidence]] : [])
      );
      serializedModelProfile = {
        ...serializedModelProfile,
        readiness: { [hostId]: projected }
      };
    }
    return res.json({
      status: 'success',
      data: {
        hostProfile: hostProfile || null,
        modelProfile: serializedModelProfile,
        toolQualification
      }
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

router.get('/context/:modelName', async (req, res) => {
  try {
    const modelName = normalizeModelTag(req.params.modelName);
    const hostUrl = normalizeHostUrl(req.query.hostUrl);
    const artifact = {
      digest: String(req.query.artifactDigest || '').trim(),
      runtimeFingerprint: String(req.query.runtimeFingerprint || '').trim()
    };
    if (!modelName || !hostUrl || !artifact.digest || !artifact.runtimeFingerprint) {
      return res.status(400).json({
        status: 'error',
        error: 'modelName, hostUrl, artifactDigest, and runtimeFingerprint are required'
      });
    }
    const contextProfile = await contextProfiles.findContextProfile(modelName, hostUrl, artifact);
    return res.json({ status: 'success', data: { contextProfile: contextProfile || null } });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

router.get('/roster', async (req, res) => {
  try {
    const data = await performanceProfiles.getRoster({
      hostId: req.query.hostId || undefined,
      modelName: req.query.modelName || undefined
    });
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

router.get('/runtime/:modelName', async (req, res) => {
  const modelName = normalizeModelTag(req.params.modelName);
  const hostId = String(req.query.hostId || '').trim();
  const hostUrl = normalizeHostUrl(req.query.hostUrl);
  if (!modelName || !hostId || !hostUrl) {
    return res.status(400).json({
      status: 'error',
      code: 'RUNTIME_ARTIFACT_IDENTITY_SELECTOR_REQUIRED',
      error: 'modelName, hostId, and hostUrl are required'
    });
  }
  try {
    const receipt = await resolveRuntimeArtifactReceipt(modelName, hostId, hostUrl);
    return res.json({ status: 'success', data: { receipt } });
  } catch (err) {
    return res.status(err.statusCode || 409).json({
      status: 'error',
      code: err.code || 'RUNTIME_ARTIFACT_IDENTITY_UNAVAILABLE',
      error: err.message
    });
  }
});

router.get('/:modelName/:hostId', async (req, res) => {
  try {
    const data = await performanceProfiles.getActiveProfile(req.params.modelName, req.params.hostId);
    if (!data) return res.status(404).json({ status: 'error', error: 'Profile evidence not found' });
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
module.exports.projectReadinessEntry = projectReadinessEntry;
