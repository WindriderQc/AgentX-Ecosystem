/**
 * Model Router Tests
 * Tests for multi-model routing functionality
 */

process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';
process.env.AGENTX_DEFAULT_CHAT_MODEL = 'deployment/default-model';
delete process.env.AGENTX_CHAT_MODEL;
delete process.env.AGENTX_GENERAL_CHAT_MODEL;
delete process.env.AGENTX_LIGHTWEIGHT_MODEL;
delete process.env.AGENTX_QUICK_CHAT_MODEL;
delete process.env.AGENTX_UTILITY_MODEL;
delete process.env.AGENTX_RAG_MODEL;
delete process.env.AGENTX_DAILY_OPERATOR_MODEL;
delete process.env.AGENTX_NESTOR_ANSWER_LIGHT_MODEL;
delete process.env.NESTOR_ANSWER_LIGHT_MODEL;
delete process.env.AGENTX_MASTER_BRAIN_MODEL;
delete process.env.AGENTX_MASTER_BRAIN_HOST;
delete process.env.AGENTX_DEEP_REASONING_MODEL;
delete process.env.AGENTX_DEEP_REASONING_HOST;
delete process.env.AGENTX_CODING_SPECIALIST_MODEL;
delete process.env.AGENTX_CODING_SPECIALIST_HOST;
delete process.env.AGENTX_ANALYSIS_MODEL;
delete process.env.AGENTX_ANALYSIS_HOST;

jest.mock('../../src/helpers/schedulerClient', () => ({
    resolveAdvisoryHost: jest.fn(async ({ fallbackHostUrl, fallbackHostId }) => ({
        source: 'fallback',
        hostId: fallbackHostId || null,
        hostUrl: fallbackHostUrl,
        reason: 'test fallback',
        claimId: null,
        claimExpiresAt: null,
        recommendation: null
    }))
}));

const {
    getTargetForModel,
    getModelForTask,
    routeRequest,
    HOSTS,
    TASK_MODELS
} = require('../../src/services/modelRouter');

describe('Model Router Service', () => {
    describe('getTargetForModel', () => {
        it('should fall back to secondary for unknown models (advisory routing active)', () => {
            const target = getTargetForModel('qwen2.5:7b-instruct-q4_0');
            // Advisory system handles per-request routing dynamically.
            // Fallback goes to secondary (interactive host) for unknown models.
            expect(target).toBe(HOSTS.secondary);
        });

        it('should return secondary host for a known interactive model', () => {
            const target = getTargetForModel('qwen3.5:9b');
            expect(target).toBe(HOSTS.secondary);
        });

        it('should return primary for undefined model', () => {
            const target = getTargetForModel(undefined);
            expect(target).toBe(HOSTS.primary || HOSTS.secondary || HOSTS.tertiary);
        });

        it('should return primary for null model', () => {
            const target = getTargetForModel(null);
            expect(target).toBe(HOSTS.primary || HOSTS.secondary || HOSTS.tertiary);
        });

        it('should fallback to secondary (interactive) for unknown models', () => {
            const target = getTargetForModel('some-model:70b');
            expect(target).toBe(HOSTS.secondary || HOSTS.tertiary);
        });

        it('should route embedding-like models to the configured embedding host', () => {
            const target = getTargetForModel('custom-embed-model');
            expect(target).toBe(HOSTS.secondary || HOSTS.tertiary);
        });
    });

    describe('getModelForTask', () => {
        it('should return configured quick_chat model/host', () => {
            const result = getModelForTask('quick_chat');
            expect(result.model).toBe(TASK_MODELS.quick_chat.model);
            expect(result.host).toBe(TASK_MODELS.quick_chat.host);
        });

        it('should route buddy chat separately while preserving the lightweight Buddy lane', () => {
            const chat = getModelForTask('buddy_chat');
            const reaction = getModelForTask('buddy_reaction');
            expect(chat.model).toBe(reaction.model);
            expect(chat.host).toBe(reaction.host);
        });

        it('should return configured code_generation model/host', () => {
            const result = getModelForTask('code_generation');
            expect(result.model).toBe('deployment/default-model');
            expect(result.host).toBe(TASK_MODELS.code_generation.host);
        });

        it('uses one deployment model for non-embedding tasks unless explicitly overridden', () => {
            const taskTypes = [
                'quick_chat', 'general_chat', 'code_generation', 'code_review',
                'deep_reasoning', 'master_brain', 'analysis', 'summarization',
                'translation', 'daily_operator', 'nestor_answer_light',
                'buddy_reaction', 'buddy_chat', 'voice_persona_chat',
                'voice_persona_reader', 'janitor_ai',
            ];
            expect(new Set(taskTypes.map(task => getModelForTask(task).model)))
                .toEqual(new Set(['deployment/default-model']));
        });

        it('should return configured deep_reasoning model/host', () => {
            const result = getModelForTask('deep_reasoning');
            expect(result.model).toBe(TASK_MODELS.deep_reasoning.model);
            expect(result.host).toBe(TASK_MODELS.deep_reasoning.host);
        });

        it('should fallback to general_chat for unknown task', () => {
            const result = getModelForTask('unknown_task');
            expect(result.model).toBe(TASK_MODELS.general_chat.model);
            expect(result.host).toBe(TASK_MODELS.general_chat.host);
        });
    });

    describe('routeRequest', () => {
        it('should use preferred model when specified', async () => {
            const result = await routeRequest('Hello', {
                preferredModel: 'qwen3.5:9b'
            });
            expect(result.model).toBe('qwen3.5:9b');
            expect(result.target).toBe('http://secondary:11434');
            expect(result.source).toBe('fallback');
            expect(result.routed).toBe(false);
        });

        it('should route based on taskType', async () => {
            const result = await routeRequest('Write code', {
                taskType: 'code_generation'
            });
            expect(result.model).toBe(TASK_MODELS.code_generation.model);
            expect(result.target).toBe(HOSTS[TASK_MODELS.code_generation.host]);
            expect(result.source).toBe('fallback');
            expect(result.routed).toBe(true);
            expect(result.taskType).toBe('code_generation');
        });

        it('should return default when no routing options', async () => {
            const result = await routeRequest('Hello', {});
            expect(result.model).toBe(TASK_MODELS.general_chat.model);
            expect(result.routed).toBe(false);
            expect(result.taskType).toBe('default');
        });
    });

    describe('Configuration', () => {
        it('should have valid host URLs', () => {
            expect(HOSTS.primary).toMatch(/^http:\/\//);
            expect(HOSTS.secondary).toMatch(/^http:\/\//);
        });

        it('should have all task types mapped', () => {
            const taskTypes = ['quick_chat', 'general_chat', 'code_generation',
                              'code_review', 'deep_reasoning', 'master_brain', 'analysis',
                              'summarization', 'translation', 'daily_operator', 'rag_query_expansion',
                              'rag_reranking', 'rag_compression', 'nestor_answer_light',
                              'buddy_reaction', 'buddy_chat',
                              'voice_persona_chat', 'voice_persona_reader', 'janitor_ai',
                              'embeddings'];
            taskTypes.forEach(task => {
                expect(TASK_MODELS[task]).toBeDefined();
                expect(TASK_MODELS[task].model).toBeDefined();
                expect(TASK_MODELS[task].host).toBeDefined();
            });
        });
    });
});
