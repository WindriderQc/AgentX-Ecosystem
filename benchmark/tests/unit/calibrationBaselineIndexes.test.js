const CalibrationBaseline = require('../../models/CalibrationBaseline');

describe('CalibrationBaseline indexes', () => {
    const JUDGE_IDENTITY_FINGERPRINT = 'a'.repeat(64);

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

    test('uses an immutable exact identity while preserving legacy document validation', () => {
        const identityPath = CalibrationBaseline.schema.path('judge_identity_fingerprint');
        expect(identityPath.options.immutable).toBe(true);

        const legacy = new CalibrationBaseline({ label: 'legacy-baseline' });
        expect(legacy.validateSync()).toBeUndefined();

        const invalid = new CalibrationBaseline({
            label: 'invalid-identity',
            judge_identity_fingerprint: 'not-a-fingerprint'
        }).validateSync();
        expect(invalid.errors.judge_identity_fingerprint).toBeDefined();
    });

    test('enforces one active baseline per exact judge identity', () => {
        const identitySlot = CalibrationBaseline.schema.indexes().find(([, options]) => (
            options?.name === 'uniq_active_calibration_baseline_by_identity'
        ));

        expect(identitySlot).toBeDefined();
        expect(identitySlot[0]).toEqual({ identity_active_slot: 1 });
        expect(identitySlot[1]).toMatchObject({
            unique: true,
            partialFilterExpression: { identity_active_slot: { $type: 'string' } }
        });
    });

    test('fails closed unless exactly one canonical active row exists for the requested identity', async () => {
        const init = jest.spyOn(CalibrationBaseline, 'init').mockResolvedValue(CalibrationBaseline);
        const lean = jest.fn().mockResolvedValue([{
            _id: 'canonical',
            active: true,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
            identity_active_slot: JUDGE_IDENTITY_FINGERPRINT
        }]);
        const find = jest.spyOn(CalibrationBaseline, 'find').mockReturnValue({ lean });

        await expect(CalibrationBaseline.getActive(JUDGE_IDENTITY_FINGERPRINT))
            .resolves.toMatchObject({ _id: 'canonical' });
        expect(init).toHaveBeenCalled();
        expect(find).toHaveBeenCalledWith({
            $or: expect.arrayContaining([
                { judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT, active: true },
                { identity_active_slot: JUDGE_IDENTITY_FINGERPRINT }
            ])
        });

        lean.mockResolvedValueOnce([{
            _id: 'inconsistent',
            active: true,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        }]);
        await expect(CalibrationBaseline.getActive(JUDGE_IDENTITY_FINGERPRINT))
            .rejects.toMatchObject({ code: 'CALIBRATION_BASELINE_CONFLICT', statusCode: 409 });

        find.mockRestore();
        init.mockRestore();
    });
});
