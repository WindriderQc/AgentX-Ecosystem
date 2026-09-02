const { stripMarkdownCodeFences, tryParseJson } = require('./jsonUtils');
const { validateJobShopSchedule } = require('./jobShopScheduleValidator');

const VALIDATOR_KEYS = Object.freeze([
    'job_shop_schedule',
    'dfa_divisible_by_3',
    'numeric_vector',
    'csv_table',
    'csv_fields',
    'numeric_tuple',
    'key_value_fields',
    'numeric_answer'
]);

const DFA_STATES = Object.freeze(['S0', 'S1', 'S2']);
const DFA_TRANSITIONS = Object.freeze({
    S0: { 0: 'S0', 1: 'S1' },
    S1: { 0: 'S2', 1: 'S0' },
    S2: { 0: 'S1', 1: 'S2' }
});

function pass(method, details, extra = {}) {
    return { score: 10, matched: true, method, details, ...extra };
}

function fail(method, details, extra = {}) {
    return { score: 0, matched: false, method, details, ...extra };
}

function cleanText(value) {
    return stripMarkdownCodeFences(String(value ?? '')).trim();
}

function numericValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function numbersEqual(a, b) {
    return Math.abs(a - b) <= 1e-9;
}

function parseExpectedJsonArray(expected, method) {
    const parsed = tryParseJson(expected);
    if (!parsed.success || !Array.isArray(parsed.value)) {
        return { error: fail(method, `Expected answer is not a JSON array: ${parsed.error || 'not an array'}`) };
    }
    const values = parsed.value.map(numericValue);
    if (values.some(value => value === null)) {
        return { error: fail(method, 'Expected JSON array contains non-numeric values') };
    }
    return { values };
}

function extractNumericList(text) {
    const parsed = tryParseJson(text);
    if (parsed.success && Array.isArray(parsed.value)) {
        const values = parsed.value.map(numericValue);
        if (!values.some(value => value === null)) return values;
    }

    const cleaned = cleanText(text);
    const bracket = cleaned.match(/\[([^\]]+)\]/);
    const source = bracket ? bracket[1] : cleaned;
    if (!/^-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)*$/.test(source.trim())) {
        return null;
    }

    const values = source.split(',').map(part => numericValue(part));
    return values.some(value => value === null) ? null : values;
}

function parseStandaloneJsonArray(text) {
    try {
        const parsed = JSON.parse(cleanText(text));
        if (!Array.isArray(parsed)) return null;
        const values = parsed.map(numericValue);
        return values.some(value => value === null) ? null : values;
    } catch {
        return null;
    }
}

function validateNumericVector(response, expected) {
    const method = 'numeric_vector';
    const expectedList = parseExpectedJsonArray(expected, method);
    if (expectedList.error) return expectedList.error;

    const received = parseStandaloneJsonArray(response);
    if (!received) return fail(method, 'Response does not contain a parseable numeric vector');
    if (received.length !== expectedList.values.length) {
        return fail(method, `Vector length expected ${expectedList.values.length}, got ${received.length}`);
    }

    const matched = received.every((value, index) => numbersEqual(value, expectedList.values[index]));
    return matched
        ? pass(method, 'Numeric vector values match expected result', { comparison: { expected: expectedList.values, received } })
        : fail(method, 'Numeric vector values do not match expected result', { comparison: { expected: expectedList.values, received } });
}

function splitCsvLines(text) {
    return cleanText(text)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
}

function splitCsvFields(line) {
    return String(line || '').split(',').map(field => field.trim());
}

function normalizeCell(value) {
    const number = numericValue(value);
    if (number !== null) return { kind: 'number', value: number };
    return { kind: 'text', value: String(value ?? '').trim().toLowerCase() };
}

function cellsEqual(a, b) {
    const left = normalizeCell(a);
    const right = normalizeCell(b);
    if (left.kind === 'number' && right.kind === 'number') return numbersEqual(left.value, right.value);
    return left.kind === right.kind && left.value === right.value;
}

function validateCsvTable(response, expected) {
    const method = 'csv_table';
    const expectedRows = splitCsvLines(expected).map(splitCsvFields);
    const receivedRows = splitCsvLines(response).map(splitCsvFields);

    if (expectedRows.length === 0) return fail(method, 'Expected CSV table is empty');
    if (receivedRows.length !== expectedRows.length) {
        return fail(method, `CSV row count expected ${expectedRows.length}, got ${receivedRows.length}`);
    }

    for (let row = 0; row < expectedRows.length; row++) {
        if (receivedRows[row].length !== expectedRows[row].length) {
            return fail(method, `CSV row ${row + 1} field count expected ${expectedRows[row].length}, got ${receivedRows[row].length}`);
        }
        for (let col = 0; col < expectedRows[row].length; col++) {
            if (!cellsEqual(receivedRows[row][col], expectedRows[row][col])) {
                return fail(method, `CSV cell ${row + 1}:${col + 1} expected ${expectedRows[row][col]}, got ${receivedRows[row][col]}`);
            }
        }
    }

    return pass(method, 'CSV rows, fields, and numeric values match expected table');
}

function validateCsvFields(response, expected) {
    const method = 'csv_fields';
    const expectedFields = splitCsvFields(cleanText(expected));
    const receivedFields = splitCsvFields(cleanText(response));

    if (receivedFields.length !== expectedFields.length) {
        return fail(method, `CSV field count expected ${expectedFields.length}, got ${receivedFields.length}`);
    }

    const matched = receivedFields.every((field, index) => cellsEqual(field, expectedFields[index]));
    return matched
        ? pass(method, 'CSV field values match expected output')
        : fail(method, 'CSV field values do not match expected output', { comparison: { expected: expectedFields, received: receivedFields } });
}

function extractLabelledNumber(text, label) {
    const pattern = new RegExp(`${label}\\s*(?:=|:)\\s*(-?\\d+(?:\\.\\d+)?)`, 'i');
    const match = cleanText(text).match(pattern);
    return match ? numericValue(match[1]) : null;
}

function validateNumericTuple(response, expected) {
    const method = 'numeric_tuple';
    const expectedValues = extractNumericList(expected);
    if (!expectedValues) return fail(method, 'Expected answer is not a numeric tuple');

    const cleaned = cleanText(response).replace(/\s+/g, ' ').trim();
    const labelled = cleaned.match(/^covered\s*(?:=|:)\s*(-?\d+(?:\.\d+)?)\s*,?\s*uncovered\s*(?:=|:)\s*(-?\d+(?:\.\d+)?)\.?$/i);
    const received = labelled
        ? [numericValue(labelled[1]), numericValue(labelled[2])]
        : (/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(cleaned) ? extractNumericList(cleaned) : null);

    if (!received) return fail(method, 'Response does not contain a parseable numeric tuple');
    if (received.length !== expectedValues.length) {
        return fail(method, `Numeric tuple length expected ${expectedValues.length}, got ${received.length}`);
    }

    const matched = received.every((value, index) => numbersEqual(value, expectedValues[index]));
    return matched
        ? pass(method, 'Numeric tuple values match expected output', { comparison: { expected: expectedValues, received } })
        : fail(method, 'Numeric tuple values do not match expected output', { comparison: { expected: expectedValues, received } });
}

function parseKeyValueNumbers(text) {
    const values = new Map();
    const cleaned = cleanText(text);
    const fullPattern = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*-?\d+(?:\.\d+)?\s*(?:,\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*-?\d+(?:\.\d+)?\s*)*$/;
    if (!fullPattern.test(cleaned)) return values;

    const regex = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)/g;
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
        values.set(match[1].toLowerCase(), numericValue(match[2]));
    }
    return values;
}

function validateKeyValueFields(response, expected) {
    const method = 'key_value_fields';
    const expectedMap = parseKeyValueNumbers(expected);
    const receivedMap = parseKeyValueNumbers(response);

    if (expectedMap.size === 0) return fail(method, 'Expected answer has no key=value numeric fields');
    for (const [key, expectedValue] of expectedMap.entries()) {
        if (!receivedMap.has(key)) return fail(method, `Missing key ${key}`);
        if (!numbersEqual(receivedMap.get(key), expectedValue)) {
            return fail(method, `Key ${key} expected ${expectedValue}, got ${receivedMap.get(key)}`);
        }
    }
    if (receivedMap.size !== expectedMap.size) {
        return fail(method, `Expected ${expectedMap.size} key=value fields, got ${receivedMap.size}`);
    }

    return pass(method, 'Key=value numeric fields match expected output');
}

/**
 * Extract every numeric token from free-form prose: integers, decimals,
 * thousands-separated numbers ($1,160.75), and simple fractions (5/16 -> 0.3125).
 * Used by numeric_answer to grade math prompts whose correct answer is a set of
 * numbers embedded in explanation, where the LLM judge is unreliable.
 */
function extractAllNumbers(text) {
    const source = cleanText(text);
    const numbers = [];
    // Preserve ordinary token extraction, but also recognize human-formatted
    // thousands such as "5 000", "5\u00a0000", and "5\u202f000". Do not remove
    // spaces globally: adjacent answer values (for example "50 100") must
    // remain independently discoverable. A grouped candidate is additive, so
    // the original numeric tokens stay available to the validator as well.
    const grouped = /(^|[^\d.,])(-?\d{1,3}(?:(?:,|[ \u00a0\u202f])\d{3})+)(?![\d,.])/g;
    let groupedMatch;
    while ((groupedMatch = grouped.exec(source)) !== null) {
        const value = Number(groupedMatch[2].replace(/[, \u00a0\u202f]/g, ''));
        if (Number.isFinite(value)) numbers.push(value);
    }

    const cleaned = source.replace(/(\d),(?=\d{3}(\D|$))/g, '$1');
    const re = /-?\d+(?:\.\d+)?\/\d+(?:\.\d+)?|-?\d+(?:\.\d+)?|-?\.\d+/g;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
        const tok = m[0];
        if (tok.includes('/')) {
            const [a, b] = tok.split('/').map(Number);
            if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) numbers.push(a / b);
        } else {
            const v = Number(tok);
            if (Number.isFinite(v)) numbers.push(v);
        }
    }
    return numbers;
}

function relativeMatch(actual, expected, tol) {
    if (actual === expected) return true;
    const denom = Math.max(Math.abs(expected), 1e-9);
    return Math.abs(actual - expected) / denom <= tol;
}

/**
 * numeric_answer — verify that every required answer value appears in the
 * response within a relative tolerance. Required values come from
 * config.answer_numbers (explicit, preferred); falls back to parsing the
 * expected answer. Extra numbers in the response do not cause failure.
 */
function validateNumericAnswer(response, expected, config = {}) {
    const method = 'numeric_answer';
    let required = Array.isArray(config.answer_numbers)
        ? config.answer_numbers.map(Number).filter(Number.isFinite)
        : [];
    if (required.length === 0) required = extractAllNumbers(expected);
    if (required.length === 0) {
        return fail(method, 'No required answer numbers configured or parseable from expected');
    }

    const tol = typeof config.answer_tolerance === 'number' ? config.answer_tolerance : 0.01;
    const found = extractAllNumbers(response);
    const missing = required.filter(req => !found.some(f => relativeMatch(f, req, tol)));

    if (missing.length === 0) {
        return pass(method, `All required answer values present: ${required.join(', ')}`,
            { comparison: { required, found: found.slice(0, 20) } });
    }
    return fail(method, `Missing required answer value(s): ${missing.join(', ')} (within ${(tol * 100).toFixed(1)}%)`,
        { comparison: { required, missing, found: found.slice(0, 20) } });
}

function normalizeState(value) {
    return String(value ?? '').trim().toUpperCase();
}

function sameSet(actual, expected) {
    const actualSet = new Set(actual);
    return actualSet.size === expected.length && expected.every(item => actualSet.has(item));
}

function transitionTableFromObject(transitions) {
    const table = {};
    for (const state of DFA_STATES) {
        const row = transitions?.[state];
        if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
        table[state] = {
            0: normalizeState(row['0']),
            1: normalizeState(row['1'])
        };
    }
    return table;
}

function addTransition(table, from, input, to) {
    const state = normalizeState(from);
    const symbol = String(input ?? '').trim();
    const target = normalizeState(to);
    if (!DFA_STATES.includes(state) || !['0', '1'].includes(symbol) || !DFA_STATES.includes(target)) {
        return false;
    }
    if (!table[state]) table[state] = {};
    table[state][symbol] = target;
    return true;
}

function transitionTableFromArray(transitions) {
    const table = {};
    for (const edge of transitions || []) {
        if (!edge || typeof edge !== 'object' || Array.isArray(edge)) return null;

        if (edge.transitions && typeof edge.transitions === 'object') {
            const from = edge.state ?? edge.from ?? edge.source;
            for (const symbol of ['0', '1']) {
                if (!addTransition(table, from, symbol, edge.transitions[symbol])) return null;
            }
            continue;
        }

        const from = edge.from ?? edge.state ?? edge.source ?? edge.current;
        const input = edge.input ?? edge.symbol ?? edge.on ?? edge.char ?? edge.read;
        const to = edge.to ?? edge.next ?? edge.nextState ?? edge.target ?? edge.destination;
        if (!addTransition(table, from, input, to)) return null;
    }
    return table;
}

function normalizeDfaTransitionTable(transitions) {
    if (Array.isArray(transitions)) return transitionTableFromArray(transitions);
    if (transitions && typeof transitions === 'object') return transitionTableFromObject(transitions);
    return null;
}

function validateDfaDivisibleBy3(response) {
    const method = 'dfa_divisible_by_3';
    const parsed = tryParseJson(response);
    if (!parsed.success) return fail(method, `Failed to parse response as JSON: ${parsed.error}`);

    const dfa = parsed.value;
    if (!dfa || typeof dfa !== 'object' || Array.isArray(dfa)) {
        return fail(method, 'DFA must be a JSON object');
    }

    const states = Array.isArray(dfa.states) ? dfa.states.map(normalizeState) : [];
    const accepting = Array.isArray(dfa.accepting) ? dfa.accepting.map(normalizeState) : [];
    const table = normalizeDfaTransitionTable(dfa.transitions);

    if (!sameSet(states, DFA_STATES)) return fail(method, 'DFA states must be exactly S0,S1,S2');
    if (normalizeState(dfa.start) !== 'S0') return fail(method, 'DFA start state must be S0');
    if (!sameSet(accepting, ['S0'])) return fail(method, 'DFA accepting states must be exactly S0');
    if (!table) return fail(method, 'DFA transitions are not parseable as a complete transition table');

    for (const state of DFA_STATES) {
        for (const symbol of ['0', '1']) {
            const actual = table[state]?.[symbol];
            const expected = DFA_TRANSITIONS[state][symbol];
            if (actual !== expected) {
                return fail(method, `Transition ${state} on ${symbol} expected ${expected}, got ${actual || 'missing'}`);
            }
        }
    }

    return pass(method, 'DFA recognizes binary strings divisible by 3 with the required states and transitions');
}

function semanticValidatorKey(config = {}, prompt = {}) {
    return config.semantic_validator || config.validator || prompt.semantic_validator || null;
}

function validateSemanticOutput(response, expected, config = {}, prompt = {}) {
    const key = semanticValidatorKey(config, prompt);
    switch (key) {
        case 'job_shop_schedule':
            return validateJobShopSchedule(response);
        case 'dfa_divisible_by_3':
            return validateDfaDivisibleBy3(response, expected);
        case 'numeric_vector':
            return validateNumericVector(response, expected);
        case 'csv_table':
            return validateCsvTable(response, expected);
        case 'csv_fields':
            return validateCsvFields(response, expected);
        case 'numeric_tuple':
            return validateNumericTuple(response, expected);
        case 'key_value_fields':
            return validateKeyValueFields(response, expected);
        case 'numeric_answer':
            return validateNumericAnswer(response, expected, config);
        default:
            return null;
    }
}

module.exports = {
    VALIDATOR_KEYS,
    validateSemanticOutput,
    _internal: {
        validateDfaDivisibleBy3,
        validateNumericVector,
        validateCsvTable,
        validateCsvFields,
        validateNumericTuple,
        validateKeyValueFields,
        validateNumericAnswer,
        extractAllNumbers,
        extractNumericList,
        normalizeDfaTransitionTable
    }
};
