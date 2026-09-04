// chatService.test.js

const { handleChatRequest } = require('../../src/services/chatService');
const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');
const { getOrCreateProfile } = require('../../src/helpers/userHelpers');
const { extractResponse, buildOllamaPayload } = require('../../src/helpers/ollamaResponseHandler');
const { sanitizeOptions, resolveTarget } = require('../../src/helpers/ollamaUtils');
const { routeRequest, recordInference } = require('../../src/services/modelRouter');
const hostPreferenceService = require('../../src/services/hostPreferenceService');
const { resolveInferenceContract } = require('../../src/services/inferenceContractService');
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
jest.mock('../../src/services/modelRouter');
jest.mock('../../src/services/hostPreferenceService', () => {
    const primitives = jest.requireActual('../../src/services/hostPinPrimitives');
    return {
        getByHost: jest.fn(),
        hasActiveBenchmarkClaim: jest.fn(() => false),
        resolvePinnedRuntimeOptions: primitives.resolvePinnedRuntimeOptions
    };
});
jest.mock('../../src/services/inferenceContractService', () => ({
    hasQualifiedThinkingCapability: jest.fn(() => false),
    resolveInferenceContract: jest.fn()
}));
jest.mock('../../src/services/inferenceAdmissionService', () => ({
    beginInferenceAdmission: jest.fn(async ({ signal } = {}) => ({
        signal: signal || new AbortController().signal,
        markDispatched: jest.fn(),
        assertActive: jest.fn(),
        complete: jest.fn(async () => ({ released: true })),
        abandon: jest.fn(async () => ({ released: true }))
    }))
}));
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

        // Setup a successful exact-model inference response.
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
        resolveInferenceContract.mockResolvedValue({ version: 'agentx.inference-contract.v1' });
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

        it('uses and receipts an explicitly requested prompt version', async () => {
            PromptConfig.findOne.mockResolvedValueOnce({
                ...mockPrompt,
                name: 'reviewer',
                version: 4,
                isActive: false
            });

            const result = await handleChatRequest({
                userId: 'user123',
                model: 'llama2',
                message: 'Review this',
                persona: 'reviewer',
                promptVersion: 4
            });

            expect(PromptConfig.findOne).toHaveBeenCalledWith({ name: 'reviewer', version: 4 });
            expect(PromptConfig.getActive).not.toHaveBeenCalled();
            expect(result.prompt).toEqual({
                name: 'reviewer',
                version: 4,
                exact: true,
                requestedVersion: 4
            });
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
                routeDecision: expect.objectContaining({
                    outcome: expect.objectContaining({
                        stage: 'execution',
                        code: 'execution_succeeded'
                    })
                })
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
                routeDecision: expect.objectContaining({
                    outcome: expect.objectContaining({
                        stage: 'execution',
                        code: 'upstream_error'
                    })
                })
            }));
        });

        it('records a wrapped abort as a timeout with a terminal decision', async () => {
            routeRequest.mockResolvedValue({
                routed: false,
                model: 'llama2',
                target: 'local',
                decision: { decisionVersion: 1, selected: { model: 'llama2' } }
            });
            mockFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

            await expect(handleChatRequest({
                userId: 'user123',
                model: 'llama2',
                message: 'hi'
            })).rejects.toMatchObject({ code: 'OLLAMA_TIMEOUT' });

            expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
                status: 'timeout',
                routeDecision: expect.objectContaining({
                    outcome: expect.objectContaining({ code: 'upstream_timeout' })
                })
            }));
        });

        it('classifies contract resolution failures as pre-dispatch telemetry', async () => {
            routeRequest.mockResolvedValue({
                routed: false,
                model: 'llama2',
                target: 'local',
                decision: { decisionVersion: 1, selected: { model: 'llama2' } }
            });
            resolveInferenceContract.mockRejectedValueOnce(new Error('contract store unavailable'));

            await expect(handleChatRequest({
                userId: 'user123',
                model: 'llama2',
                message: 'hi'
            })).rejects.toThrow('contract store unavailable');

            expect(mockFetch).not.toHaveBeenCalledWith(
                expect.stringContaining('/api/chat'),
                expect.anything()
            );
            expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({
                status: 'error',
                routeDecision: expect.objectContaining({
                    outcome: {
                        stage: 'selection',
                        code: 'pre_dispatch_error',
                        reasonCode: 'inference_pre_dispatch_error'
                    }
                })
            }));
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
