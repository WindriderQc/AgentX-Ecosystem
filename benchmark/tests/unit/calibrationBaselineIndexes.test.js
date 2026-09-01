const CalibrationBaseline = require('../../models/CalibrationBaseline');

describe('CalibrationBaseline indexes', () => {
    test('enforces at most one active slot without a replica-set transaction', () => {
        const indexes = CalibrationBaseline.schema.indexes();
        const activeSlot = indexes.find(([, options]) => (
            options?.name === 'uniq_active_calibration_baseline'
        ));

        expect(activeSlot).toBeDefined();
        expect(activeSlot[0]).toEqual({ active_slot: 1 });
        expect(activeSlot[1]).toMatchObject({
            unique: true,
            partialFilterExpression: { active_slot: 'active' }
        });
    });
});
