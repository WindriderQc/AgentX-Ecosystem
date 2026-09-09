'use strict';

// Preserve complete evidence unless the caller explicitly asks for an excerpt.
// All scoring steps must see the same excerpt and report its actual extent.
function prepareJudgeResponse(response, config = {}) {
    const full = String(response ?? '');
    const limit = Number(config.response_char_budget);
    const text = Number.isInteger(limit) && limit > 0 ? full.slice(0, limit) : full;
    return {
        text,
        evidence: {
            response_truncated_for_judge: text.length < full.length,
            response_chars: full.length,
            judge_window_chars: text.length
        }
    };
}

function assertJudgeInputUnmodified(data) {
    const changes = data?.agentx_contract?.contextBudget?.transformations;
    if (changes?.truncation?.applied === true || changes?.condensation?.applied === true) {
        throw new Error('Judge input was truncated or condensed upstream; quality was not evaluated');
    }
    // A character-based overflow estimate is not proof of a runtime truncation.
    // Keep the existing report-only behavior for that estimate.
}

function assertJudgeOutputComplete(data) {
    // A parseable JSON object or YES/NO prefix is not a completed verdict when
    // the runtime says generation stopped at its limit.
    if (data?.done_reason === 'length' || data?.done === false) {
        throw new Error('Judge output was incomplete; quality was not evaluated');
    }
}

module.exports = { prepareJudgeResponse, assertJudgeInputUnmodified, assertJudgeOutputComplete };
