/**
 * Integration Tests for Streaming SSE API Endpoint
 * Tests POST /api/chat/stream for SSE headers, events, and authentication
 */

const request = require('supertest');

// Mock chatService before requiring app
jest.mock('../../src/services/chatService');

// Auth was stripped from core. With no auth context, getUserId(res) returns
// the default userId 'default'. Tests below assert that behavior.

const chatService = require('../../src/services/chatService');
const Conversation = require('../../models/Conversation');

// Load app after mocks
const { app } = require('../../src/app');

/**
 * Helper to parse SSE events from a stream
 * Handles chunked data and processes remaining buffer on end
 */
function createSSEParser(eventHandlers = {}) {
    let text = '';

    const processEvents = (data) => {
        text += data;
        const parts = text.split('\n\n');
        text = parts.pop() || ''; // Keep incomplete part

        parts.forEach(part => {
            if (!part.trim()) return;

            // Extract event type and data
            const eventMatch = part.match(/event: (\w+)/);
            const dataMatch = part.match(/data: ({.*})/);

            if (eventMatch && dataMatch) {
                const eventType = eventMatch[1];
                try {
                    const eventData = JSON.parse(dataMatch[1]);
                    if (eventHandlers[eventType]) {
                        eventHandlers[eventType](eventData);
                    }
                    if (eventHandlers.onAny) {
                        eventHandlers.onAny(eventType, eventData);
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            }
        });
    };

    const flush = () => {
        // Process any remaining complete events in the buffer
        if (text.trim()) {
            processEvents('\n\n'); // Force processing of remaining text
        }
    };

    return { processEvents, flush };
}

describe('POST /api/chat/stream - Streaming SSE Endpoint', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('1. SSE Headers and Format', () => {
        it('should return SSE headers', async () => {
            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({ response: 'Test', conversationId: 'conv123' });
            });

            const response = await request(app)
                .post('/api/chat/stream')
                .send({
                    model: 'llama2',
                    message: 'Hello'
                });

            expect(response.headers['content-type']).toContain('text/event-stream');
            expect(response.headers['cache-control']).toBe('no-cache');
            expect(response.headers['connection']).toBe('keep-alive');
        });

        it('should return SSE headers for GET requests', async () => {
            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({ response: 'Test', conversationId: 'conv123' });
            });

            const payload = Buffer.from(JSON.stringify({ model: 'llama2', message: 'Hello' })).toString('base64');

            const response = await request(app)
                .get('/api/chat/stream')
                .query({ payload });

            expect(response.headers['content-type']).toContain('text/event-stream');
            expect(response.headers['cache-control']).toBe('no-cache');
            expect(response.headers['connection']).toBe('keep-alive');
        });

        it('should stream token events progressively', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                onToken('Hello');
                onToken(' world');
                onToken('!');
                onComplete({ response: 'Hello world!', conversationId: 'conv123' });
            });

            const tokens = [];

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .parse((res, callback) => {
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: token')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) tokens.push(JSON.parse(match[1]).content);
                            }
                        });
                    });
                    res.on('end', () => {
                        callback(null, { tokens });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(tokens).toEqual(['Hello', ' world', '!']);
                    done();
                });
        }, 10000);

        it('should emit done event with conversationId and messageId', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                onToken('Response');
                onComplete({
                    response: 'Response',
                    conversationId: 'conv456',
                    messageId: 'msg789',
                    stats: { eval_count: 10 },
                    ragSources: []
                });
            });

            let doneEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .parse((res, callback) => {
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: done')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) doneEvent = JSON.parse(match[1]);
                            }
                        });
                    });
                    res.on('end', () => {
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent).toMatchObject({
                        conversationId: 'conv456',
                        messageId: 'msg789',
                        stats: { eval_count: 10 }
                    });
                    done();
                });
        }, 10000);
    });

    describe('2. Error Handling', () => {
        it('should emit error event on invalid model', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onError }) => {
                onError(new Error('Model not found'));
            });

            let errorEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'invalid-model', message: 'Test' })
                .parse((res, callback) => {
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: error')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) errorEvent = JSON.parse(match[1]);
                            }
                        });
                    });
                    res.on('end', () => {
                        callback(null, { errorEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(errorEvent).toMatchObject({
                        message: 'Model not found'
                    });
                    done();
                });
        }, 10000);

        it('should return 400 if message is missing', async () => {
            const response = await request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2' });

            expect(response.status).toBe(400);
            expect(response.body.message).toContain('Message is required');
        });

        it('should return 400 if model is missing and autoRoute disabled', async () => {
            const response = await request(app)
                .post('/api/chat/stream')
                .send({ message: 'Test' });

            expect(response.status).toBe(400);
            expect(response.body.message).toContain('Model is required');
        });

        it('should handle service-level errors gracefully', (done) => {
            const serviceError = new Error('Service unavailable');
            serviceError.code = 'OLLAMA_UNAVAILABLE';
            serviceError.statusCode = 503;
            chatService.handleChatRequestStream = jest.fn().mockRejectedValue(serviceError);

            let errorEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .parse((res, callback) => {
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: error')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) errorEvent = JSON.parse(match[1]);
                            }
                        });
                    });
                    res.on('end', () => {
                        callback(null, { errorEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(errorEvent).toBeTruthy();
                    expect(errorEvent.message).toContain('Service unavailable');
                    expect(errorEvent.code).toBe('OLLAMA_UNAVAILABLE');
                    expect(errorEvent.statusCode).toBe(503);
                    done();
                });
        }, 10000);
    });

    describe('3. Thinking Model Streams', () => {
        it('should emit thinking events separately from token events', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onThinking, onToken, onComplete }) => {
                onThinking('Analyzing...');
                onThinking(' the problem');
                onToken('Here is');
                onToken(' the answer');
                onComplete({
                    response: 'Here is the answer',
                    thinking: 'Analyzing... the problem',
                    conversationId: 'conv123'
                });
            });

            const thinkingEvents = [];
            const tokenEvents = [];

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'deepseek-r1', message: 'Complex question' })
                .parse((res, callback) => {
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: thinking')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) thinkingEvents.push(JSON.parse(match[1]).content);
                            }
                            if (part.includes('event: token')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) tokenEvents.push(JSON.parse(match[1]).content);
                            }
                        });
                    });
                    res.on('end', () => {
                        callback(null, { thinkingEvents, tokenEvents });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(thinkingEvents).toEqual(['Analyzing...', ' the problem']);
                    expect(tokenEvents).toEqual(['Here is', ' the answer']);
                    done();
                });
        }, 10000);
    });

    describe('4. RAG Integration', () => {
        it('should include RAG sources in done event', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                onToken('Based on the manual');
                onComplete({
                    response: 'Based on the manual',
                    conversationId: 'conv123',
                    ragUsed: true,
                    ragSources: [{
                        text: 'Document context',
                        score: 0.92,
                        title: 'Manual.pdf',
                        source: 'uploads/manual.pdf'
                    }]
                });
            });

            let doneEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({
                    model: 'llama2',
                    message: 'What does the manual say?',
                    useRag: true
                })
                .parse((res, callback) => {
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: done')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) doneEvent = JSON.parse(match[1]);
                            }
                        });
                    });
                    res.on('end', () => {
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent.ragUsed).toBe(true);
                    expect(doneEvent.ragSources).toHaveLength(1);
                    expect(doneEvent.ragSources[0].title).toBe('Manual.pdf');
                    done();
                });
        }, 10000);
    });

    describe('5. Authentication', () => {
        it('should accept authenticated requests (optionalAuth middleware)', async () => {
            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({ response: 'Authenticated response', conversationId: 'conv123' });
            });

            const response = await request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' });

            // With optionalAuth, requests should work
            expect(response.status).toBe(200);
        });

        it('should pass the default userId through when auth is stripped', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ userId, onComplete }) => {
                expect(userId).toBe('default');
                onComplete({ response: 'Unauthenticated response', conversationId: 'conv123' });
            });

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(chatService.handleChatRequestStream).toHaveBeenCalledWith(
                        expect.objectContaining({ userId: 'default' })
                    );
                    done();
                });
        }, 10000);
    });

    describe('6. Client Disconnect Handling', () => {
        it('should log when client disconnects', (done) => {
            let isDone = false;
            const server = app.listen();
            const finish = (err) => {
                if (!isDone) {
                    isDone = true;
                    server.close((closeErr) => {
                        done(err || closeErr);
                    });
                }
            };

            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                // Simulate slow streaming
                await new Promise(resolve => setTimeout(resolve, 500));
                // Only call callbacks if we haven't timed out locally
                try {
                    if (onToken) onToken('Slow token');
                    if (onComplete) onComplete({ response: 'Slow response' });
                } catch (e) {
                    // Ignore errors writing to closed response
                }
            });

            const req = request(server)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' });

            // Simulate client disconnect after 50ms
            setTimeout(() => {
                req.abort();
                // Allow time for server to handle disconnect
                setTimeout(finish, 100);
            }, 50);

            req.end((err) => {
                // If it ends (error or success), finish
                finish(err);
            });
        }, 10000);
    });

    describe('7. Feedback Submission After Streaming', () => {
        it('should return messageId in done event for feedback', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onComplete }) => {
                onComplete({
                    response: 'Test response',
                    conversationId: 'conv123',
                    messageId: 'msg456'
                });
            });

            let doneEvent = null;

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Test' })
                .parse((res, callback) => {
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk.toString();
                        const parts = text.split('\n\n');
                        text = parts.pop();
                        parts.forEach(part => {
                            if (part.includes('event: done')) {
                                const match = part.match(/data: ({.*})/);
                                if (match) doneEvent = JSON.parse(match[1]);
                            }
                        });
                    });
                    res.on('end', () => {
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent.messageId).toBe('msg456');
                    expect(doneEvent.conversationId).toBe('conv123');
                    done();
                });
        }, 10000);
    });

    describe('8. Stats and Performance', () => {
        it('should include stats in done event', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ onToken, onComplete }) => {
                onToken('Test');
                onComplete({
                    response: 'Test',
                    conversationId: 'conv123',
                    stats: {
                        total_duration: 5000000,
                        eval_count: 50,
                        prompt_eval_count: 100
                    }
                });
            });

            let doneEvent = null;
            const parser = createSSEParser({
                done: (data) => { doneEvent = data; }
            });

            request(app)
                .post('/api/chat/stream')
                .send({ model: 'llama2', message: 'Performance test' })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        parser.processEvents(chunk.toString());
                    });
                    res.on('end', () => {
                        parser.flush();
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent).not.toBeNull();
                    expect(doneEvent.stats).toMatchObject({
                        eval_count: 50,
                        prompt_eval_count: 100
                    });
                    done();
                });
        }, 10000);
    });

    describe('9. Auto-Routing with Streaming', () => {
        it('should support auto-routing in streaming mode', (done) => {
            chatService.handleChatRequestStream = jest.fn(async ({ autoRoute, onToken, onComplete }) => {
                expect(autoRoute).toBe(true);
                onToken('Routed response');
                onComplete({
                    response: 'Routed response',
                    model: 'gpt-4',
                    routing: { taskType: 'coding', routed: true }
                });
            });

            let doneEvent = null;
            const parser = createSSEParser({
                done: (data) => { doneEvent = data; }
            });

            request(app)
                .post('/api/chat/stream')
                .send({
                    message: 'Write Python code',
                    autoRoute: true
                })
                .parse((res, callback) => {
                    res.on('data', (chunk) => {
                        parser.processEvents(chunk.toString());
                    });
                    res.on('end', () => {
                        parser.flush();
                        callback(null, { doneEvent });
                    });
                })
                .end((err, res) => {
                    if (err) return done(err);
                    expect(doneEvent).not.toBeNull();
                    expect(doneEvent.routing).toMatchObject({
                        taskType: 'coding',
                        routed: true
                    });
                    done();
                });
        }, 10000);
    });
});
