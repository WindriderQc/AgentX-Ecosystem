// chatService.test.js

const { handleChatRequest } = require('../../src/services/chatService');
const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');
const { getOrCreateProfile } = require('../../src/helpers/userHelpers');
const { extractResponse, buildOllamaPayload } = require('../../src/helpers/ollamaResponseHandler');
const { sanitizeOptions, resolveTarget } = require('../../src/helpers/ollamaUtils');
const { tryHandleToolCommand } = require('../../src/services/toolService');
const { executeTool, parseToolCalls } = require('../../src/services/toolExecutor');
const { routeRequest, recordInference } = require('../../src/services/modelRouter');
const hostPreferenceService = require('../../src/services/hostPreferenceService');
const { calculateMessageCost, calculateConversationCost } = require('../../src/services/costCalculator');
const logger = require('../../config/logger');

// Mock dependencies with factories
jest.mock('../../models/Conversation', () => {
    const mockSave = jest.fn().mockResolvedValue(true);
    // Use a factory function for the constructor
    const MockModel = jest.fn((data) => ({
        ...data,
        _id: data && data._id ? data._id : 'conv123',
        // Mock messages as an array with Mongoose-like methods
        messages: Object.assign(data && data.messages ? [...data.messages] : [], {
            create: jest.fn((msg) => ({ ...msg, _id: 'msg-' + Date.now(), metadata: {} })),
            push: jest.fn(function(item) { return Array.prototype.push.call(this, item); })
        }),
        save: mockSave,
        markModified: jest.fn()
    }));

    // Attach static methods
    MockModel.findById = jest.fn();
    MockModel.findOne = jest.fn();

    return MockModel;
});

jest.mock('../../models/PromptConfig', () => ({
    getActive: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn()
}));

jest.mock('../../src/helpers/userHelpers');
jest.mock('../../src/helpers/ollamaResponseHandler');
jest.mock('../../src/helpers/ollamaUtils');
jest.mock('../../src/services/toolService');
jest.mock('../../src/services/toolExecutor');
jest.mock('../../src/services/modelRouter');
jest.mock('../../src/services/hostPreferenceService', () => {
    const primitives = jest.requireActual('../../src/services/hostPinPrimitives');
    return {
        getByHost: jest.fn(),
        hasActiveBenchmarkClaim: jest.fn(() => false),
        resolvePinnedRuntimeOptions: primitives.resolvePinnedRuntimeOptions
    };
});
jest.mock('../../src/services/costCalculator');
jest.mock('../../config/logger');

// Mock node-fetch
jest.mock('node-fetch');
const mockFetch = require('node-fetch');

describe('chatService', () => {

    const mockUser = {
        _id: 'user123',
        username: 'testuser',
        about: 'I am a test user',
        preferences: { customInstructions: 'Be concise' }
    };

    const mockPrompt = {
        _id: 'prompt123',
        systemPrompt: 'You are a helpful assistant.',
        name: 'default_chat',
        version: 'v1'
    };

    const mockStats = {
        total_duration: 1000,
        eval_count: 50,
        prompt_eval_count: 20,
        model: 'llama2'
    };

    const mockCost = {
        totalCost: 0.0001,
        inputCost: 0.00005,
        outputCost: 0.00005,
        currency: 'USD',
        pricingSource: { source: 'mock' }
    };

    const mockRagStore = {
        searchSimilarChunks: jest.fn(),
        listDocuments: jest.fn()
    };

    beforeEach(async () => {
        jest.clearAllMocks();

        // Setup successful fetch mock — return 404 for /api/show (adapted model check), ok for everything else
        mockFetch.mockImplementation((url) => {
            if (typeof url === 'string' && url.includes('/api/show')) {
                return Promise.resolve({ ok: false, status: 404 });
            }
            return Promise.resolve({
                ok: true,
                statusText: 'OK',
                json: jest.fn().mockResolvedValue({
                    response: 'Test response',
                    done: true,
                    ...mockStats
                })
            });
        });

        // Setup default mock implementations
        PromptConfig.getActive.mockResolvedValue(mockPrompt);
        PromptConfig.findOne.mockResolvedValue(mockPrompt); // Ensure findOne is also mocked

        getOrCreateProfile.mockResolvedValue(mockUser);
        resolveTarget.mockReturnValue('http://localhost:11434');
        buildOllamaPayload.mockReturnValue({ model: 'llama2', messages: [] });
        extractResponse.mockReturnValue({
            content: 'Test response',
            thinking: null,
            warning: null,
            stats: mockStats
        });

        // Utils defaults
        sanitizeOptions.mockReturnValue({});

        // Routing defaults
        routeRequest.mockResolvedValue({ routed: false, model: 'llama2', target: 'local' });
        hostPreferenceService.getByHost.mockResolvedValue(null);
        // Tool defaults
        tryHandleToolCommand.mockResolvedValue(null);
        parseToolCalls.mockReturnValue(null);
        executeTool.mockResolvedValue({ status: 'success', data: 'tool result' });

        // Cost calculation defaults
        calculateMessageCost.mockResolvedValue(mockCost);
        calculateConversationCost.mockReturnValue({ sum: 0.0002 });

        // Conversation Mock Defaults (handled by factory, but ensure scoped lookups return null by default for new chats)
        Conversation.findById.mockResolvedValue(null);
        Conversation.findOne.mockResolvedValue(null);
    });

    describe('Standard Chat Flow', () => {
        it('should handle a basic chat request from a user', async () => {
            const request = {
                userId: 'user123',
                model: 'llama2',
                message: 'Hello world'
            };

            const result = await handleChatRequest(request);

            expect(result).toBeDefined();
            expect(result.response).toBe('Test response');
            expect(result.model).toBe('llama2');

            // Verify dependencies called
            expect(PromptConfig.getActive).toHaveBeenCalledWith('default_chat');
            expect(getOrCreateProfile).toHaveBeenCalledWith('user123');
            expect(resolveTarget).toHaveBeenCalled();
            expect(mockFetch).toHaveBeenCalled();
            expect(calculateMessageCost).toHaveBeenCalled();
            expect(Conversation).toHaveBeenCalled(); // New conversation created
        });

        it('should include the current user message in the Ollama payload', async () => {
            await handleChatRequest({
                userId: 'user123',
                model: 'llama2',
                message: 'Hello world',
                messages: [{ role: 'assistant', content: 'Previous answer' }]
            });

            expect(buildOllamaPayload).toHaveBeenCalledWith(expect.objectContaining({
                messages: [
                    { role: 'system', content: expect.stringContaining('You are a helpful assistant.') },
                    { role: 'assistant', content: 'Previous answer' },
                    { role: 'user', content: 'Hello world' }
                ]
            }));
        });

        it('uses the matching pin context and keep-alive for non-streaming chat (0512)', async () => {
            hostPreferenceService.getByHost.mockResolvedValue({
                pinnedModels: [{
                    model: 'ax/gemma4:31b-it-qat',
                    keepAlive: -1,
                    contextSize: 49152,
                    autoRestore: true
                }]
            });

            const result = await handleChatRequest({
                userId: 'user123',
                model: 'ax/gemma4:31b-it-qat',
                target: 'http://localhost:11434',
                message: 'Think deeply'
            });

            expect(buildOllamaPayload).toHaveBeenCalledWith(expect.objectContaining({
                model: 'ax/gemma4:31b-it-qat',
                options: expect.objectContaining({ num_ctx: 49152, keep_alive: -1 })
            }));
            expect(result.numCtx).toBe(49152);
            expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
                num_ctx: 49152,
                num_ctx_source: 'host_preference_pin',
                observability: expect.objectContaining({
                    contract: expect.objectContaining({ version: 'agentx.inference-contract.v1' }),
                    outcome: expect.objectContaining({ visibleFinal: true, completed: true })
                })
            }));
        });

        it('should use existing conversation if conversationId is provided', async () => {
            // Mock an existing conversation instance
            const mockExistingConvInstance = {
                _id: 'existing123',
                userId: 'user123',
                messages: [], // Real array
                save: jest.fn().mockResolvedValue(true)
            };

            // Allow push and create (if used)
            mockExistingConvInstance.messages.push = jest.fn((item) => mockExistingConvInstance.messages.length + 1);
            mockExistingConvInstance.messages.create = jest.fn((msg) => ({ ...msg, _id: 'newmsg', metadata: {} }));

            Conversation.findOne.mockResolvedValue(mockExistingConvInstance);

            const request = {
                userId: 'user123',
                model: 'llama2',
                message: 'Continue chat',
                conversationId: 'existing123'
            };

            const result = await handleChatRequest(request);

            expect(result.conversationId).toBe('existing123');
            expect(Conversation.findOne).toHaveBeenCalledWith({
                _id: 'existing123',
                userId: 'user123',
                'lifecycle.status': { $ne: 'archived' }
            });
            expect(mockExistingConvInstance.messages.push).toHaveBeenCalled();
            expect(mockExistingConvInstance.save).toHaveBeenCalled();
        });

        it('should create a new conversation when the provided ID is outside the caller scope', async () => {
            const request = {
                userId: 'user123',
                model: 'llama2',
                message: 'Continue chat',
                conversationId: 'foreign123'
            };

            const result = await handleChatRequest(request);

            expect(result.conversationId).toBe('conv123');
            expect(Conversation.findOne).toHaveBeenCalledWith({
                _id: 'foreign123',
                userId: 'user123',
                'lifecycle.status': { $ne: 'archived' }
            });
            expect(Conversation).toHaveBeenCalledWith(expect.objectContaining({
                userId: 'user123'
            }));
        });
    });

    describe('Model Routing', () => {
        it('should perform auto-routing when autoRoute is true', async () => {
            routeRequest.mockResolvedValue({
                routed: true,
                autoRouted: true,
                classificationMs: 42,
                model: 'gpt-4',
                target: 'openai',
                host: 'secondary',
                taskType: 'coding'
            });

            const request = {
                userId: 'user123',
                message: 'Write code',
                autoRoute: true
            };

            const result = await handleChatRequest(request);

            expect(routeRequest).toHaveBeenCalledWith('Write code', expect.objectContaining({ autoRoute: true }));
            expect(result.model).toBe('gpt-4');
            expect(result.routing).toEqual({
                taskType: 'coding',
                routed: true,
                autoRouted: true,
                classificationMs: 42,
                routedModel: 'gpt-4',
                routedHost: 'secondary',
                routedHostUrl: 'openai'
            });
            expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
                taskType: 'coding',
                routed: true,
                autoRouted: true,
                classificationMs: 42,
                routedModel: 'gpt-4',
                routedHost: 'secondary',
                routedHostUrl: 'openai'
            }));
        });

        it('should resolve manual model targets through routeRequest when no auto-route', async () => {
            routeRequest.mockResolvedValue({ routed: false, model: 'mistral', target: 'remote-host' });

            const request = {
                userId: 'user123',
                model: 'mistral',
                message: 'Ping'
            };

            const result = await handleChatRequest(request);

            expect(routeRequest).toHaveBeenCalledWith('Ping', expect.objectContaining({
                preferredModel: 'mistral',
                caller: 'chat-service'
            }));
            expect(result.target).toBe('remote-host');
        });

        // RouteDecision attribution (0519): routeRequest builds exactly one
        // decision per call; chat used to drop it before telemetry. These
        // assert the decision is present on the actual recorded row — a
        // shape-only assertion is what let the original gap ship.
        it('threads the routeRequest decision onto the success telemetry row', async () => {
            const decision = {
                decisionVersion: 1,
                attribution: { caller: 'chat-service', callerDetail: 'chat-user123' }
            };
            routeRequest.mockResolvedValue({
                routed: true,
                autoRouted: true,
                classificationMs: 42,
                model: 'gpt-4',
                target: 'openai',
                host: 'secondary',
                taskType: 'coding',
                decision
            });

            await handleChatRequest({ userId: 'user123', message: 'Write code', autoRoute: true });

            expect(routeRequest).toHaveBeenCalledWith('Write code', expect.objectContaining({
                callerDetail: 'chat-user123'
            }));
            expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
                status: 'success',
                routeDecision: decision
            }));
        });

        it('attributes the failure row too, not just successful ones', async () => {
            const decision = { decisionVersion: 1 };
            routeRequest.mockResolvedValue({ routed: false, model: 'llama2', target: 'local', decision });
            mockFetch.mockRejectedValue(new Error('Network error'));

            await expect(handleChatRequest({
                userId: 'user123',
                model: 'llama2',
                message: 'hi'
            })).rejects.toThrow();

            expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
                status: 'error',
                routeDecision: decision
            }));
        });
    });

    describe('Tool Execution', () => {
        it('should handle command-line style tools (tryHandleToolCommand)', async () => {
            tryHandleToolCommand.mockResolvedValue({
                responseText: 'Command executed',
                ok: true,
                tool: 'calculator'
            });

            const request = {
                userId: 'user123',
                model: 'llama2',
                message: '/calc 2+2'
            };

            const result = await handleChatRequest(request);

            expect(tryHandleToolCommand).toHaveBeenCalledWith('/calc 2+2');
            expect(result.response).toBe('Command executed');
            expect(result.toolOk).toBe(true);
            // Verify normal chat flow (ollama fetch) was SKIPPED
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should handle LLM-initiated tool calls', async () => {
            parseToolCalls.mockReturnValue({ tool: 'weather', params: { city: 'London' } });
            executeTool.mockResolvedValue({ status: 'success', data: { temp: 20 } });

            const request = {
                userId: 'user123',
                model: 'llama2',
                message: 'Check weather'
            };

            const result = await handleChatRequest(request);

            expect(parseToolCalls).toHaveBeenCalledWith('Test response');
            expect(executeTool).toHaveBeenCalledWith('weather', { city: 'London' });
            expect(result.response).toContain('Tool Execution');
            expect(result.response).toContain('Test response'); // Assuming result is appended
        });
    });

    describe('Error Handling', () => {
        it('should throw error when Ollama request fails', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                statusText: 'Internal Server Error'
            });

            const request = {
                userId: 'user123',
                model: 'llama2',
                message: 'Hi'
            };

            await expect(handleChatRequest(request)).rejects.toThrow('Ollama request failed: Internal Server Error');
        });

        it('should classify missing Ollama models without falling back to 500', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                json: jest.fn().mockResolvedValue({
                    error: "model 'missing-model:latest' not found"
                })
            });

            const request = {
                userId: 'user123',
                model: 'missing-model:latest',
                message: 'Hi'
            };

            await expect(handleChatRequest(request)).rejects.toMatchObject({
                code: 'MODEL_UNAVAILABLE',
                statusCode: 404,
                upstreamStatus: 404,
                upstreamMessage: "model 'missing-model:latest' not found"
            });
        });

        it('should handle fetch network errors', async () => {
            mockFetch.mockRejectedValue(new Error('Network error'));

            const request = {
                userId: 'user123',
                model: 'llama2',
                message: 'Hi'
            };

            await expect(handleChatRequest(request)).rejects.toThrow('Failed to connect to Ollama');
        });

        it('should handle AbortError (timeout)', async () => {
             const error = new Error('The operation was aborted');
             error.name = 'AbortError';
             mockFetch.mockRejectedValue(error);

             const request = {
                 userId: 'user123',
                 model: 'llama2',
                 message: 'Hi'
             };

             await expect(handleChatRequest(request)).rejects.toThrow('Ollama request timed out');
        });
    });

    describe('Cost Calculation', () => {
        it('should calculate costs and attach to conversation message', async () => {
             const request = { userId: 'user123', message: 'test', model: 'llama2' };
             await handleChatRequest(request);

             expect(calculateMessageCost).toHaveBeenCalledWith('llama2', mockStats);
             // We can check if logger was called with 'Message cost calculated' to verify internal flow
             expect(logger.debug).toHaveBeenCalledWith('Message cost calculated', expect.any(Object));
        });
    });

});
