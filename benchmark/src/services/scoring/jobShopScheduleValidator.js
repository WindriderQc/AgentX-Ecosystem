const { tryParseJson } = require('./jsonUtils');

const EXPECTED_JOBS = Object.freeze({
    J1: { machine: 'M2', start: 0, end: 3 },
    J2: { machine: 'M1', start: 0, end: 4 },
    J3: { machine: 'M2', start: 3, end: 5 },
    J4: { machine: 'M1', start: 4, end: 7 },
    J5: { machine: 'M2', start: 7, end: 9 }
});

const REQUIRED_TOP_LEVEL_KEYS = ['schedule', 'makespan'];

function normalizeJobId(value) {
    const raw = String(value ?? '').trim().toUpperCase();
    if (/^[1-5]$/.test(raw)) return `J${raw}`;
    if (/^J[1-5]$/.test(raw)) return raw;
    return raw;
}

function normalizeMachine(value) {
    const raw = String(value ?? '').trim().toUpperCase();
    if (/^[12]$/.test(raw)) return `M${raw}`;
    return raw;
}

function toFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function hasOnlyRequiredTopLevelKeys(value) {
    const keys = Object.keys(value || {}).sort();
    return keys.length === REQUIRED_TOP_LEVEL_KEYS.length
        && REQUIRED_TOP_LEVEL_KEYS.every(key => keys.includes(key));
}

function normalizeSchedule(schedule) {
    if (!Array.isArray(schedule)) {
        return { jobs: null, errors: ['schedule must be an array'] };
    }

    const errors = [];
    const jobs = new Map();

    for (const item of schedule) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push('each schedule entry must be an object');
            continue;
        }

        const id = normalizeJobId(item.id);
        const machine = normalizeMachine(item.machine);
        const start = toFiniteNumber(item.start);
        const end = toFiniteNumber(item.end);

        if (!EXPECTED_JOBS[id]) errors.push(`unknown job id ${String(item.id)}`);
        if (jobs.has(id)) errors.push(`duplicate job id ${id}`);
        if (!['M1', 'M2'].includes(machine)) errors.push(`invalid machine for ${id || 'unknown'}`);
        if (start === null || end === null) errors.push(`invalid start/end for ${id || 'unknown'}`);

        jobs.set(id, { id, machine, start, end });
    }

    return { jobs, errors };
}

function validateExpectedJobs(jobs) {
    const errors = [];
    const expectedIds = Object.keys(EXPECTED_JOBS);

    for (const id of expectedIds) {
        const actual = jobs.get(id);
        const expected = EXPECTED_JOBS[id];
        if (!actual) {
            errors.push(`missing ${id}`);
            continue;
        }

        if (actual.machine !== expected.machine) {
            errors.push(`${id} machine expected ${expected.machine}, got ${actual.machine}`);
        }
        if (actual.start !== expected.start || actual.end !== expected.end) {
            errors.push(`${id} expected ${expected.start}-${expected.end}, got ${actual.start}-${actual.end}`);
        }
    }

    if (jobs.size !== expectedIds.length) {
        errors.push(`expected ${expectedIds.length} jobs, got ${jobs.size}`);
    }

    return errors;
}

function validateNoMachineOverlap(jobs) {
    const errors = [];
    const byMachine = new Map();

    for (const job of jobs.values()) {
        if (!byMachine.has(job.machine)) byMachine.set(job.machine, []);
        byMachine.get(job.machine).push(job);
    }

    for (const [machine, machineJobs] of byMachine.entries()) {
        machineJobs.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        for (let i = 1; i < machineJobs.length; i++) {
            const prev = machineJobs[i - 1];
            const next = machineJobs[i];
            if (next.start < prev.end) {
                errors.push(`${machine} overlap between ${prev.id} and ${next.id}`);
            }
        }
    }

    return errors;
}

function validatePrecedence(jobs) {
    const errors = [];
    const j1 = jobs.get('J1');
    const j2 = jobs.get('J2');
    const j3 = jobs.get('J3');
    const j4 = jobs.get('J4');
    const j5 = jobs.get('J5');

    if (j1 && (j1.start < 0 || j1.start > 1)) {
        errors.push('J1 must start inside window [0,1]');
    }
    if (j1 && j3 && j3.start !== j1.end) {
        errors.push('J3 must start immediately after J1');
    }
    if (j2 && j4 && j4.start !== j2.end) {
        errors.push('J4 must start immediately after J2');
    }
    if (j3 && j4 && j5 && j5.start < Math.max(j3.end, j4.end)) {
        errors.push('J5 must start after both J3 and J4');
    }

    return errors;
}

function validateMakespan(parsed, jobs) {
    const makespan = toFiniteNumber(parsed.makespan);
    if (makespan === null) return ['makespan must be numeric'];

    const computed = Math.max(...[...jobs.values()].map(job => job.end));
    if (makespan !== computed) {
        return [`makespan expected ${computed}, got ${makespan}`];
    }
    if (makespan !== 9) {
        return [`optimal makespan expected 9, got ${makespan}`];
    }
    return [];
}

function validateJobShopSchedule(response) {
    const parsed = tryParseJson(response);
    if (!parsed.success) {
        return {
            score: 0,
            matched: false,
            method: 'job_shop_schedule',
            details: `Failed to parse response as JSON: ${parsed.error}`
        };
    }

    const value = parsed.value;
    const errors = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push('top-level JSON value must be an object');
    } else if (!hasOnlyRequiredTopLevelKeys(value)) {
        errors.push('top-level object must contain only schedule and makespan');
    }

    const { jobs, errors: scheduleErrors } = normalizeSchedule(value?.schedule);
    errors.push(...scheduleErrors);

    if (jobs) {
        errors.push(...validateExpectedJobs(jobs));
        errors.push(...validateNoMachineOverlap(jobs));
        errors.push(...validatePrecedence(jobs));
        if (jobs.size > 0) errors.push(...validateMakespan(value, jobs));
    }

    const matched = errors.length === 0;
    return {
        score: matched ? 10 : 0,
        matched,
        method: 'job_shop_schedule',
        details: matched
            ? 'Schedule satisfies job set, machines, timing, precedence, and makespan'
            : `Job-shop schedule validation failed: ${errors.join('; ')}`
    };
}

module.exports = {
    validateJobShopSchedule,
    _internal: {
        normalizeJobId,
        normalizeMachine,
        normalizeSchedule,
        validateExpectedJobs,
        validateNoMachineOverlap,
        validatePrecedence,
        validateMakespan
    }
};
