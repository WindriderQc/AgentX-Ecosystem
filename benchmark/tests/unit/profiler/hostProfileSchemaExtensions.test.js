const HostProfile = require('../../../models/HostProfile');

describe('HostProfile schema extensions', () => {
    const baseProfile = {
        hostId: 'cpu-test-host',
        hostUrl: 'http://192.0.2.66:11434'
    };

    it('stores CPU core counts', async () => {
        const doc = new HostProfile({
            ...baseProfile,
            cpu: { cores: 16 }
        });
        await doc.validate();
        expect(doc.cpu.cores).toBe(16);
    });

    it('stores CPU thread overrides', async () => {
        const doc = new HostProfile({
            ...baseProfile,
            hostId: 'cpu-thread-test',
            cpu: { cores: 16, threadOverride: 8 }
        });
        await doc.validate();
        expect(doc.cpu.cores).toBe(16);
        expect(doc.cpu.threadOverride).toBe(8);
    });
});
