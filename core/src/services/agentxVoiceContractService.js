const voixSettings = require('./voixSettingsService');

const CONTRACT_VERSION = 'agentx-voice-v1';

const CURRENT_CORE_PROXY_ENDPOINTS = Object.freeze([
  'GET /api/voix/contract',
  'GET /api/voix/health',
  'GET /api/voix/devices',
  'GET /api/voix/settings',
  'PATCH /api/voix/settings',
  'GET /api/voix/config',
  'POST /api/voix/config',
  'GET /api/voix/metrics',
  'GET /api/voix/models',
  'GET /api/voix/voice-profile',
  'POST /api/voix/transcribe',
  'POST /api/voix/synthesize',
  'POST /api/voix/sessions',
  'GET /api/voix/sessions',
  'POST /api/voix/sessions/start',
  'POST /api/voix/sessions/stop',
  'POST /api/voix/sessions/cancel',
  'GET /api/voix/sessions/status',
  'GET /api/voix/sessions/:id',
  'GET /api/voix/sessions/:id/events',
  'POST /api/voix/sessions/text-turn',
  'POST /api/voix/diagnostics/smoke',
  'POST /api/voix/diagnostics/tts-smoke'
]);

const AGENTX_VOICE_V1_TARGET_ENDPOINTS = Object.freeze([
  'GET /voice/health',
  'GET /voice/devices',
  'POST /voice/devices/verify',
  'POST /voice/sessions',
  'POST /voice/sessions/:id/ptt/start',
  'POST /voice/sessions/:id/ptt/stop',
  'POST /voice/sessions/:id/transcribe',
  'POST /voice/sessions/:id/speak',
  'POST /voice/sessions/:id/cancel',
  'GET /voice/sessions/:id/events'
]);

const VOICE_EVENT_TYPES = Object.freeze([
  'session_created',
  'capture_started',
  'audio_captured',
  'stt_started',
  'stt_completed',
  'llm_started',
  'llm_completed',
  'tts_started',
  'tts_completed',
  'playback_started',
  'playback_completed',
  'interrupted',
  'session_error'
]);

function featureStatus(feature) {
  if (!feature || feature.enabled === false) return 'disabled';
  return 'configured';
}

function buildAgentXVoiceContract({ generatedAt = new Date() } = {}) {
  const settings = voixSettings.getSettings();
  const features = settings.features || {};

  return {
    version: CONTRACT_VERSION,
    status: 'contract_boundary',
    generatedAt: generatedAt.toISOString(),
    authority: {
      core: 'AgentX Core owns persona, memory, audit, routing, settings, and the current /api/voix proxy surface.',
      voixNative: 'VoiX owns Windows microphone, speaker, STT, TTS, device diagnostics, playback timing, and future native VAD/wake loops.',
      surfaceSatellite: 'A Surface-local voice satellite should own always-listening capture and call AgentX Voice/Core by contract.'
    },
    runtime: {
      voiceMode: settings.voiceMode,
      voiceModeSource: settings.voiceModeSource,
      voixBaseUrl: settings.baseUrl,
      voixBaseUrlSource: settings.baseUrlSource,
      timeoutMs: settings.timeoutMs,
      longTimeoutMs: settings.longTimeoutMs
    },
    capabilities: {
      pushToTalk: {
        status: 'available',
        owner: 'browser or VoiX native via Core proxy',
        currentPath: 'Browser mic -> POST /api/voix/transcribe -> persona/core turn -> POST /api/voix/synthesize'
      },
      stt: {
        status: featureStatus(features.stt),
        provider: features.stt?.provider || 'unknown',
        owner: features.stt?.provider === 'voix' ? 'VoiX native' : 'browser'
      },
      tts: {
        status: featureStatus(features.tts),
        provider: features.tts?.provider || 'unknown',
        owner: features.tts?.provider === 'voix' ? 'VoiX native' : 'browser'
      },
      nativeSessions: {
        status: featureStatus(features.convoMode),
        provider: features.convoMode?.provider || 'voix',
        currentPath: '/api/voix/sessions/*'
      },
      vad: {
        status: 'not_implemented',
        owner: 'VoiX native or Surface-local voice satellite',
        gating: ['visible mic-active state', 'hard mute or obvious software pause', 'parent/audit surface']
      },
      wakeWord: {
        status: 'not_implemented',
        owner: 'VoiX native or Surface-local voice satellite',
        gating: ['local-first engine', 'false-positive handling', 'visible mic-active state', 'hard mute or obvious software pause']
      },
      physicalAudioLoop: {
        status: 'external',
        owner: 'VoiX native or Surface-local voice satellite',
        note: 'Core does not own PortAudio, microphone capture loops, playback timing, or always-listening behavior.'
      }
    },
    routes: {
      currentCoreProxy: CURRENT_CORE_PROXY_ENDPOINTS,
      agentxVoiceV1Target: AGENTX_VOICE_V1_TARGET_ENDPOINTS
    },
    eventTypes: VOICE_EVENT_TYPES,
    boundaryEvolution: {
      currentCanonicalPath: '/api/voix/*',
      targetBoundary: 'AgentX Voice v1 can start as a Core module or thin wrapper, then extract to an independently deployable service.',
      compatibilityRule: 'Do not add wake-word or VAD behavior to browser surfaces until a native satellite reports those capabilities.'
    }
  };
}

module.exports = {
  CONTRACT_VERSION,
  buildAgentXVoiceContract
};
