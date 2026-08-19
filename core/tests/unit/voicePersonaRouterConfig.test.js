const {
  DIRECT_INVOKE_TASKS,
  TASK_TYPE_METADATA,
  isClassifiableTask,
  isDirectInvokeTask
} = require('../../src/services/modelRouterConfig');
const { resolveLane } = require('../../src/services/inferenceLanePolicy');

describe('voice persona router config', () => {
  test('registers voice persona tasks as direct router tasks', () => {
    expect(isDirectInvokeTask('nestor_answer_light')).toBe(true);
    expect(isClassifiableTask('nestor_answer_light')).toBe(false);
    expect(DIRECT_INVOKE_TASKS.nestor_answer_light).toEqual({
      model: 'gemma4:26b-a4b-it-qat',
      host: 'primary'
    });
    expect(TASK_TYPE_METADATA.nestor_answer_light.title).toBe('Nestor Answer Light');

    expect(isDirectInvokeTask('voice_persona_chat')).toBe(true);
    expect(DIRECT_INVOKE_TASKS.voice_persona_chat).toEqual(expect.objectContaining({
      model: expect.any(String),
      host: expect.any(String)
    }));
    expect(TASK_TYPE_METADATA.voice_persona_chat.title).toBe('Voice Persona Chat');

    expect(isDirectInvokeTask('voice_persona_reader')).toBe(true);
    expect(isClassifiableTask('voice_persona_reader')).toBe(false);
    expect(DIRECT_INVOKE_TASKS.voice_persona_reader).toEqual(expect.objectContaining({
      model: expect.any(String),
      host: expect.any(String)
    }));
    expect(TASK_TYPE_METADATA.voice_persona_reader.title).toBe('Voice Persona Reader');
  });

  test('routes voice persona callers through the interactive lane', () => {
    const lane = resolveLane('chat-voice-personas/personal_operator');

    expect(lane.name).toBe('interactive');
    expect(lane.policy.route).toBe(true);
    expect(lane.policy.admit).toBe(true);
  });
});
