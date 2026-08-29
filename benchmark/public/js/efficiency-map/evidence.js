// public/js/efficiency-map/evidence.js

export function isRankableEfficiencyEntry(entry) {
    return Boolean(entry)
        && Number.isFinite(entry.avgQuality)
        && entry.avgQuality >= 0
        && entry.avgQuality <= 10
        && Number.isFinite(entry.avgTokPerSec)
        && entry.avgTokPerSec > 0
        && Number.isFinite(entry.efficiencyScore)
        && entry.efficiencyScore >= 0
        && entry.efficiencyScore <= 100;
}

export function rankableEfficiencyEntries(entries) {
    if (!Array.isArray(entries)) return [];

    return entries
        .filter(isRankableEfficiencyEntry)
        .sort((a, b) => (
            b.efficiencyScore - a.efficiencyScore
            || b.avgQuality - a.avgQuality
            || b.avgTokPerSec - a.avgTokPerSec
        ));
}

export const NO_THROUGHPUT_MESSAGE =
    'No valid throughput evidence. Run a successful throughput benchmark to create an efficiency ranking.';
