/**
 * Quick Scorer
 * Fast JSON-exact-match scoring for structured outputs.
 * Only triggers when both expected_answer and response parse as valid JSON.
 *
 * Hardcoded text patterns were removed - deterministic scoring and the
 * LLM judge handle all non-JSON cases through proper evaluation pipelines.
 */

const logger = require('../../../config/logger');
const { tryParseJson, jsonDeepEqual } = require('./jsonUtils');

/**
 * Quick scoring via JSON deep comparison.
 * Returns null when prompt has no expected_answer or when either side is not JSON.
 * Downstream scorers (deterministic, LLM judge) handle everything else.
 */
function quickScore(response, prompt) {
    if (!prompt) {
        return null;
    }

    const deterministicConfig = prompt.deterministic_scoring || {};
    const strictExactContract = deterministicConfig.type === 'exact'
        && prompt.output_contract
        && prompt.output_contract.type === 'exact'
        && !deterministicConfig.semantic_validator
        && !deterministicConfig.validator;
    if (strictExactContract) {
        return null;
    }

    const expectedAnswer = prompt.expected_answer || prompt.expected;
    if (!expectedAnswer) {
        return null;
    }

    const expectedJson = tryParseJson(expectedAnswer);
    const responseJson = tryParseJson(response);

    if (expectedJson.success && responseJson.success) {
        const isEqual = jsonDeepEqual(expectedJson.value, responseJson.value);
        logger.info('Quick JSON scoring', {
            matched: isEqual,
            expectedType: Array.isArray(expectedJson.value) ? 'array' : typeof expectedJson.value,
            responseType: Array.isArray(responseJson.value) ? 'array' : typeof responseJson.value
        });
        if (!isEqual) {
            return null;
        }
        return {
            quick: true,
            score: 10,
            expected: expectedAnswer,
            matched: true,
            pattern: 'json_exact_match',
            comparison: {
                expected: expectedJson.value,
                received: responseJson.value
            }
        };
    }

    // Non-JSON prompts: let deterministic scorer or LLM judge handle them
    return null;
}

module.exports = { quickScore };
