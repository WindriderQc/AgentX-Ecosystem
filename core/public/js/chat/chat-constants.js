/**
 * Chat constants — localStorage keys, defaults, magic strings
 */

export const STORAGE_KEYS = {
  SETTINGS: 'agentx-settings',
  ONBOARDING_SEEN: 'agentx_chat_onboarding_seen',
  PROFILE_PROMPT_DISMISSED: 'agentx_profile_prompt_dismissed',
  CHECKLIST_DISMISSED: 'agentx_checklist_dismissed',
  LAST_CONVERSATION_ID: 'agentx_last_conversation_id',
  PROFILE_UPDATED: 'agentx_profile_updated',
};

export const DEFAULTS = {
  settingsVersion: 8,
  routingMode: 'standard',
  host: 'localhost',
  port: '11434',
  model: '',
  stream: true,
  tts: false,
  ttsProvider: 'browser',
  sttProvider: 'browser',
  sttLanguage: 'en',
  whisperModel: '',
  voiceAutoSend: false,
  ttsVoice: 'alloy',
  useRag: true,
  think: false,
  system: 'You are AgentX, a concise and capable local assistant. Keep answers brief and actionable.',
  options: {
    temperature: 0.7,
    top_p: 0.9,
    top_k: 64,
    num_ctx: '',
    repeat_penalty: 1.05,
    presence_penalty: 0,
    frequency_penalty: 0,
    num_predict: '',
    seed: '',
    stop: '',
    keep_alive: '',
  },
};
