// Shared setup for pure unit tests that deliberately skip MongoDB.
process.env.NODE_ENV = 'test';
if (!process.env.OLLAMA_HOST) process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
