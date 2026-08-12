const logger = require('../../../config/logger');

function buildSourceTitle(metadata = {}, index = 0) {
  return metadata.filename || metadata.source || metadata.documentId || `Source ${index + 1}`;
}

function truncateExcerpt(text) {
  if (!text || typeof text !== 'string') return '';
  return text.length > 220 ? text.slice(0, 220) : text;
}

function toRagSource(result, index) {
  const metadata = result && result.metadata && typeof result.metadata === 'object' ? result.metadata : {};
  const title = buildSourceTitle(metadata, index);
  // Use compressedText if available (contextual compression was applied)
  const wasCompressed = result.wasCompressed === true;
  const displayText = wasCompressed && typeof result.compressedText === 'string'
    ? result.compressedText.trim()
    : (typeof result?.text === 'string' ? result.text.trim() : '');
  const score = Number(result?.score);

  return {
    documentId: metadata.documentId || `source-${index + 1}`,
    score: Number.isFinite(score) ? score : null,
    text: displayText,
    excerpt: truncateExcerpt(displayText),
    title,
    source: metadata.source || title,
    metadata: {
      ...metadata,
      filename: title,
      filepath: metadata.source || null
    },
    wasCompressed,
    compressionRatio: wasCompressed ? (result.compressionRatio || 0) : 0
  };
}

function buildRagContextText(sources) {
  return sources.map((source, index) => {
    const match = Number.isFinite(source.score) ? ` (${(source.score * 100).toFixed(0)}% match)` : "";
    return `[${index + 1}] ${source.title}${match}
${source.text}`;
  }).join("\n\n");
}

async function buildRagContext(query, ragStore, options = {}) {
  if (!ragStore || !query || typeof query !== 'string' || query.trim().length === 0) {
    return { ragUsed: false, ragSources: [], ragContext: null };
  }

  try {
    const useHybrid = options.ragOptions?.ragHybrid === true;
    const useRerank = options.ragOptions?.ragRerank === true;
    const useCompress = options.ragOptions?.ragCompress === true;
    const results = await ragStore.searchSimilarChunks(query, {
      topK: Number(options.ragTopK) || 5,
      filters: options.ragFilters,
      minScore: useHybrid ? 0.15 : 0.3,
      expand: options.ragOptions?.ragExpand === true,
      hybrid: useHybrid,
      rerank: useRerank,
      compress: useCompress
    });

    if (!Array.isArray(results) || results.length === 0) {
      return { ragUsed: false, ragSources: [], ragContext: null };
    }

    const ragSources = results.map(toRagSource);
    return {
      ragUsed: true,
      ragSources,
      ragContext: buildRagContextText(ragSources)
    };
  } catch (error) {
    logger.warn('Standalone RAG lookup failed', { error: error.message });
    return { ragUsed: false, ragSources: [], ragContext: null };
  }
}

module.exports = { buildRagContext };
