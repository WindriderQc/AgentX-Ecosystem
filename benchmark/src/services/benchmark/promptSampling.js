/**
 * Prompt Sampling
 * Selection and sampling of benchmark prompts by depth and category
 */

/**
 * Group an array by a key function
 */
function groupBy(arr, keyFn) {
    const groups = {};
    for (const item of arr) {
        const key = typeof keyFn === 'function' ? keyFn(item) : item[keyFn];
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
    }
    return groups;
}

/**
 * Pick N random items from an array (Fisher-Yates partial shuffle)
 */
function randomPick(arr, n) {
    if (n >= arr.length) return [...arr];
    const copy = [...arr];
    for (let i = copy.length - 1; i > copy.length - 1 - n; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(copy.length - n);
}

/**
 * Sample prompts according to depth configuration.
 *
 * Depth modes:
 *   off    — skip level entirely
 *   single — pick the canonical representative (representative: true), or first prompt as fallback
 *   light  — one prompt per category (balanced coverage)
 *   full   — all prompts
 */
function samplePromptsByDepth(prompts, depthConfig) {
    const byLevel = groupBy(prompts, 'level');
    const sampled = [];

    for (const [level, levelPrompts] of Object.entries(byLevel)) {
        const depth = depthConfig[level] || depthConfig[String(level)] || 'off';
        if (depth === 'off') continue;
        if (depth === 'full') {
            sampled.push(...levelPrompts);
            continue;
        }

        if (depth === 'single') {
            const rep = levelPrompts.find(p => p.representative);
            const picked = rep || levelPrompts[0];
            if (picked !== undefined) sampled.push(picked);
            continue;
        }

        const byCategory = groupBy(levelPrompts, 'category');

        if (depth === 'light') {
            for (const catPrompts of Object.values(byCategory)) {
                sampled.push(randomPick(catPrompts, 1)[0]);
            }
        }
    }

    return sampled;
}

module.exports = { groupBy, randomPick, samplePromptsByDepth };
