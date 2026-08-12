/**
 * JSON Utilities for Quality Scoring
 * Markdown stripping, JSON extraction, and deep comparison
 */

/**
 * Strip markdown code fences from a response
 */
function stripMarkdownCodeFences(text) {
    if (!text || typeof text !== 'string') return text;

    const codeBlockRegex = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/;
    const trimmed = text.trim();
    const match = trimmed.match(codeBlockRegex);

    if (match) {
        return match[1].trim();
    }

    const inlineMatch = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)```$/);
    if (inlineMatch) {
        return inlineMatch[1].trim();
    }

    return text;
}

/**
 * Compare two JSON values for equality
 * Arrays are compared with order sensitivity
 * Objects are compared with key-order insensitivity
 */
function jsonDeepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((val, idx) => jsonDeepEqual(val, b[idx]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
        const keysA = Object.keys(a).sort();
        const keysB = Object.keys(b).sort();
        if (keysA.length !== keysB.length) return false;
        if (!keysA.every((k, i) => k === keysB[i])) return false;
        return keysA.every(k => jsonDeepEqual(a[k], b[k]));
    }

    return false;
}

/**
 * Try to parse JSON from a response string
 * Handles various formats: raw JSON, markdown code blocks, etc.
 */
function tryParseJson(text) {
    if (!text || typeof text !== 'string') {
        return { success: false, value: null, error: 'Empty or non-string input' };
    }

    let cleaned = stripMarkdownCodeFences(text).trim();

    try {
        const value = JSON.parse(cleaned);
        return { success: true, value, error: null };
    } catch (e) {
        const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
        if (jsonMatch) {
            try {
                const value = JSON.parse(jsonMatch[1]);
                return { success: true, value, error: null };
            } catch (e2) {
                return { success: false, value: null, error: e2.message };
            }
        }
        return { success: false, value: null, error: e.message };
    }
}

module.exports = { stripMarkdownCodeFences, jsonDeepEqual, tryParseJson };
