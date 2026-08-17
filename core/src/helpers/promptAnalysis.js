/**
 * Prompt Analysis Helper Functions
 * Analyze failure patterns and generate improvement suggestions
 */

const logger = require('../../config/logger');

/**
 * Analyze failure patterns from negative conversations
 * @param {Array} conversations - Array of conversation objects with negative feedback
 * @returns {Object} Analysis results with patterns, themes, and statistics
 */
function analyzeFailurePatterns(conversations) {
  if (!conversations || conversations.length === 0) {
    return {
      patterns: [],
      themes: [],
      stats: {
        totalConversations: 0,
        avgMessagesPerConversation: 0,
        mostCommonFailurePoints: []
      }
    };
  }

  const patterns = [];
  const themes = {};
  let totalMessages = 0;
  const failurePoints = {}; // Track where in conversation failures occur

  // Analyze each conversation
  conversations.forEach(conv => {
    const messages = conv.messages || [];
    totalMessages += messages.length;

    // Find messages with negative feedback
    const negativeMessages = messages.filter(m => m.feedback?.rating === -1);

    negativeMessages.forEach((msg, idx) => {
      // Track failure point (early, mid, late conversation)
      const position = idx / messages.length;
      let stage;
      if (position < 0.33) stage = 'early';
      else if (position < 0.67) stage = 'mid';
      else stage = 'late';

      failurePoints[stage] = (failurePoints[stage] || 0) + 1;

      // Extract keywords from feedback comments
      if (msg.feedback?.comment) {
        const comment = msg.feedback.comment.toLowerCase();

        // Common failure themes
        const themeKeywords = {
          'accuracy': ['wrong', 'incorrect', 'inaccurate', 'error', 'mistake'],
          'completeness': ['incomplete', 'missing', 'not enough', 'partial'],
          'relevance': ['irrelevant', 'off-topic', 'not related', 'unrelated'],
          'clarity': ['unclear', 'confusing', 'vague', 'ambiguous'],
          'helpfulness': ['not helpful', 'useless', 'unhelpful'],
          'tone': ['rude', 'unprofessional', 'inappropriate'],
          'length': ['too long', 'too short', 'verbose', 'brief']
        };

        Object.entries(themeKeywords).forEach(([theme, keywords]) => {
          if (keywords.some(kw => comment.includes(kw))) {
            themes[theme] = (themes[theme] || 0) + 1;
          }
        });
      }

      // Analyze message content for common issues
      if (msg.content) {
        const content = msg.content.toLowerCase();

        // Detect apologetic responses (often indicates confusion)
        if (content.includes('sorry') || content.includes('apologize')) {
          patterns.push({
            type: 'apologetic_response',
            example: msg.content.substring(0, 100) + '...',
            count: 1
          });
        }

        // Detect "I don't know" patterns
        if (content.includes("don't know") || content.includes("can't help") || content.includes("unable to")) {
          patterns.push({
            type: 'knowledge_gap',
            example: msg.content.substring(0, 100) + '...',
            count: 1
          });
        }
      }
    });
  });

  // Consolidate duplicate patterns
  const consolidatedPatterns = [];
  const patternCounts = {};

  patterns.forEach(p => {
    const key = p.type;
    if (!patternCounts[key]) {
      patternCounts[key] = { ...p, examples: [p.example] };
    } else {
      patternCounts[key].count++;
      if (patternCounts[key].examples.length < 3) {
        patternCounts[key].examples.push(p.example);
      }
    }
  });

  Object.values(patternCounts).forEach(p => {
    consolidatedPatterns.push({
      type: p.type,
      count: p.count,
      examples: p.examples
    });
  });

  // Sort themes by frequency
  const sortedThemes = Object.entries(themes)
    .sort((a, b) => b[1] - a[1])
    .map(([theme, count]) => ({ theme, count }));

  // Sort failure points
  const sortedFailurePoints = Object.entries(failurePoints)
    .sort((a, b) => b[1] - a[1])
    .map(([stage, count]) => ({ stage, count }));

  return {
    patterns: consolidatedPatterns.sort((a, b) => b.count - a.count),
    themes: sortedThemes,
    stats: {
      totalConversations: conversations.length,
      avgMessagesPerConversation: totalMessages / conversations.length,
      mostCommonFailurePoints: sortedFailurePoints
    }
  };
}

/**
 * Call Ollama to analyze failures and suggest improvements
 * @param {Object} prompt - Current prompt configuration
 * @param {Object} analysis - Failure pattern analysis
 * @param {Array} sampleConversations - Sample negative conversations (max 5)
 * @param {string} ollamaHost - Ollama API host
 * @returns {Promise<Object>} LLM analysis and suggestions
 */
async function callOllamaForAnalysis(prompt, analysis, sampleConversations, ollamaHost = process.env.OLLAMA_HOST) {
  if (!ollamaHost) {
      throw new Error('OLLAMA_HOST environment variable is required for prompt analysis');
  }
  try {
    // Prepare analysis prompt for LLM
    const analysisPrompt = `You are an expert prompt engineer. Analyze the following system prompt and its failure patterns to suggest improvements.

## Current System Prompt
${prompt.systemPrompt}

## Failure Analysis
Total Conversations with Negative Feedback: ${analysis.stats.totalConversations}
Average Messages per Conversation: ${analysis.stats.avgMessagesPerConversation.toFixed(1)}

### Common Failure Themes
${analysis.themes.map(t => `- ${t.theme}: ${t.count} occurrences`).join('\n')}

### Failure Patterns
${analysis.patterns.map(p => `- ${p.type}: ${p.count} occurrences\n  Example: "${p.examples[0]}"`).join('\n\n')}

### Failure Points in Conversation
${analysis.stats.mostCommonFailurePoints.map(fp => `- ${fp.stage} conversation: ${fp.count} occurrences`).join('\n')}

## Sample Negative Conversations
${sampleConversations.map((conv, idx) => {
  const negMsg = conv.messages.find(m => m.feedback?.rating === -1);
  return `### Conversation ${idx + 1}
User: ${conv.messages.find(m => m.role === 'user')?.content.substring(0, 200)}
Assistant: ${negMsg?.content.substring(0, 200)}
Feedback: ${negMsg?.feedback?.comment || 'No comment'}`;
}).join('\n\n')}

## Your Task
Provide a detailed analysis and specific improvement suggestions in JSON format:

{
  "root_causes": ["Primary issue 1", "Primary issue 2", ...],
  "specific_problems": [
    {"problem": "Description", "impact": "How it affects users"},
    ...
  ],
  "improvement_suggestions": [
    {
      "category": "tone|scope|constraints|examples|clarity",
      "suggestion": "Specific change to make",
      "rationale": "Why this helps"
    },
    ...
  ],
  "suggested_prompt": "Your improved version of the entire system prompt",
  "expected_improvements": ["What should improve 1", "What should improve 2", ...]
}

Be specific and actionable. Focus on changes that directly address the identified failure patterns.`;

    const analysisModel = process.env.PROMPT_ANALYSIS_MODEL
      || process.env.OLLAMA_ANALYSIS_MODEL
      || process.env.OLLAMA_MODEL
      || process.env.AGENTX_DEFAULT_CHAT_MODEL;
    if (!analysisModel) {
      throw new Error('A configured analysis or default chat model is required for prompt analysis');
    }

    const fetch = (await import('node-fetch')).default;

    // Call Ollama with analysis model (configurable)
    const response = await fetch(`${ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: analysisModel,
        prompt: analysisPrompt,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 2000
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const result = await response.json();
    let analysisText = result.response;

    // Try to extract JSON from response
    let structuredAnalysis;
    try {
      // Look for JSON block in markdown code fence
      const jsonMatch = analysisText.match(/```json\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        structuredAnalysis = JSON.parse(jsonMatch[1]);
      } else {
        // Try to parse entire response as JSON
        structuredAnalysis = JSON.parse(analysisText);
      }
    } catch (parseError) {
      logger.warn('Failed to parse structured analysis, returning raw text', { error: parseError.message });
      structuredAnalysis = {
        root_causes: ['Analysis parsing failed'],
        specific_problems: [],
        improvement_suggestions: [],
        suggested_prompt: prompt.systemPrompt,
        expected_improvements: [],
        raw_analysis: analysisText
      };
    }

    return {
      success: true,
      analysis: structuredAnalysis,
      raw_response: analysisText,
      model_used: analysisModel
    };

  } catch (error) {
    logger.error('Ollama analysis failed', { error: error.message });
    return {
      success: false,
      error: error.message,
      fallback: true
    };
  }
}

module.exports = {
  analyzeFailurePatterns,
  callOllamaForAnalysis
};
