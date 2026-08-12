/**
 * Artillery Load Test Helpers for Streaming Tests
 * Provides timing utilities and custom metrics for SSE streaming
 */

const timers = {};

/**
 * Start timer for request
 */
function startTimer(requestParams, context, ee, next) {
    const requestId = context._uid || Date.now();
    timers[requestId] = Date.now();
    context._requestId = requestId;
    next();
}

/**
 * Record streaming latency metrics
 */
function recordStreamLatency(requestParams, response, context, ee, next) {
    const requestId = context._requestId;

    if (timers[requestId]) {
        const latency = Date.now() - timers[requestId];

        // Emit custom metrics
        ee.emit('customStat', {
            stat: 'streaming.latency',
            value: latency
        });

        // Categorize latency
        if (latency < 1000) {
            ee.emit('customStat', {
                stat: 'streaming.fast',
                value: 1
            });
        } else if (latency < 5000) {
            ee.emit('customStat', {
                stat: 'streaming.medium',
                value: 1
            });
        } else {
            ee.emit('customStat', {
                stat: 'streaming.slow',
                value: 1
            });
        }

        // Clean up
        delete timers[requestId];
    }

    // Parse SSE response if available
    if (response && response.body) {
        try {
            const body = response.body.toString();

            // Count token events
            const tokenMatches = body.match(/event: token/g);
            const tokenCount = tokenMatches ? tokenMatches.length : 0;

            ee.emit('customStat', {
                stat: 'streaming.tokens',
                value: tokenCount
            });

            // Check for thinking events
            const thinkingMatches = body.match(/event: thinking/g);
            if (thinkingMatches && thinkingMatches.length > 0) {
                ee.emit('customStat', {
                    stat: 'streaming.thinking_events',
                    value: thinkingMatches.length
                });
            }

            // Check for done event
            if (body.includes('event: done')) {
                ee.emit('customStat', {
                    stat: 'streaming.completed',
                    value: 1
                });

                // Extract stats from done event
                const doneMatch = body.match(/event: done\ndata: ({.*})/);
                if (doneMatch) {
                    try {
                        const doneData = JSON.parse(doneMatch[1]);

                        if (doneData.stats) {
                            if (doneData.stats.eval_count) {
                                ee.emit('customStat', {
                                    stat: 'streaming.eval_tokens',
                                    value: doneData.stats.eval_count
                                });
                            }

                            if (doneData.stats.prompt_eval_count) {
                                ee.emit('customStat', {
                                    stat: 'streaming.prompt_tokens',
                                    value: doneData.stats.prompt_eval_count
                                });
                            }
                        }

                        // Check for RAG usage
                        if (doneData.ragUsed && doneData.ragSources) {
                            ee.emit('customStat', {
                                stat: 'streaming.rag_sources',
                                value: doneData.ragSources.length
                            });
                        }
                    } catch (parseErr) {
                        // Ignore parse errors in stats
                    }
                }
            }

            // Check for error events
            if (body.includes('event: error')) {
                ee.emit('customStat', {
                    stat: 'streaming.errors',
                    value: 1
                });
            }

        } catch (err) {
            // Ignore parsing errors
        }
    }

    next();
}

/**
 * Add timestamp to request for tracking
 */
function addTimestamp(requestParams, context, ee, next) {
    context._timestamp = Date.now();
    next();
}

/**
 * Generate random message for variety
 */
function generateRandomMessage(requestParams, context, ee, next) {
    const messages = [
        "Explain machine learning",
        "What is quantum computing?",
        "Describe neural networks",
        "How does NLP work?",
        "What are transformers in AI?",
        "Explain reinforcement learning",
        "What is deep learning?",
        "How do GANs work?",
        "Explain computer vision",
        "What is natural language processing?"
    ];

    context.vars.randomMessage = messages[Math.floor(Math.random() * messages.length)];
    next();
}

module.exports = {
    startTimer,
    recordStreamLatency,
    addTimestamp,
    generateRandomMessage
};
