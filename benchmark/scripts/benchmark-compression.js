/*
 * Benchmark script for RAG Contextual Compression
 */
require('dotenv').config();
const { getCompressionService } = require('../src/services/ragCompression');
const logger = require('../config/logger');

// Mock data
const mockChunks = [
    {
        _id: '1',
        text: `The AgentX system is a comprehensive platform for AI orchestration. It includes multiple components including chat interfaces, model management, and analytics dashboards. The RAG system is one of these components. It uses vector embeddings to enable semantic search across documents. The system integrates with Qdrant as the vector database. Users can upload documents via the UI or API. The ingestion pipeline processes documents and creates embeddings using the nomic-embed-text model. Retrieved chunks are then injected into LLM prompts.`
    },
    {
        _id: '2',
        text: `AgentX also supports n8n integration. This allows users to build automation workflows that can be triggered by the chat interface. The n8n integration uses webhooks to communicate with n8n servers.`
    }
];

const query = "How does the RAG system work?";

async function runBenchmark() {
    console.log('🚀 Starting Compression Benchmark...');
    console.log(`Query: "${query}"`);
    console.log(`Original Chunks: ${mockChunks.length}`);

    // Disable logger console output for clean test if possible, or we just ignore logs
    try {
        if (logger.transports) {
             logger.transports.forEach((t) => (t.silent = true));
        }
    } catch (e) { /* ignore */ }

    const service = getCompressionService();
    try {
        service.clearCache();
    } catch (e) { /* ignore if not implemented yet */ }

    // Check if Ollama is reachable
    const fetch = require('node-fetch');
    try {
        await fetch(process.env.OLLAMA_HOST || 'http://localhost:11434');
    } catch (e) {
        console.warn('⚠️  Ollama host not reachable. Benchmark might fail if not using mocks.');
    }

    const start = Date.now();
    const result = await service.compressChunks(query, mockChunks, {
        minRelevanceScore: 0.6,
        maxSentencesPerChunk: 5,
        useCache: false
    });
    const end = Date.now();

    const duration = end - start;
    const avgPerChunk = duration / mockChunks.length;

    console.log('\n📊 Results:');
    console.log(`----------------------------------------`);
    console.log(`Time Total:       ${duration}ms`);
    console.log(`Avg per Chunk:    ${avgPerChunk.toFixed(0)}ms`);
    console.log(`Compressed Chunks: ${result.length}`);

    // Calculate token savings (using rough estimate)
    const originalChars = mockChunks.reduce((acc, c) => acc + c.text.length, 0);
    const compressedChars = result.reduce((acc, c) => acc + (c.compressedText?.length || 0), 0);
    const reduction = originalChars > 0
        ? ((originalChars - compressedChars) / originalChars * 100).toFixed(1)
        : 0;

    console.log(`Char Reduction:   ${reduction}%`);
    console.log(`Original Chars:   ${originalChars}`);
    console.log(`Compressed Chars: ${compressedChars}`);

    console.log('\n📝 Compressed Output:');
    result.forEach((r, i) => {
        console.log(`\n[Chunk ${i+1}]`);
        console.log(r.compressedText);
    });

    process.exit(0);
}

runBenchmark().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
