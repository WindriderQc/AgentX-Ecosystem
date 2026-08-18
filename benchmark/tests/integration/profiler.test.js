const request = require('supertest');

jest.mock('../../src/services/profiler/hostProfileService', () => ({
    getAll: jest.fn()
}));

jest.mock('../../src/services/profiler/modelProfileService', () => ({
    getReadinessFunnel: jest.fn(),
    getStalenessReport: jest.fn(),
    getBenchmarkedModelNames: jest.fn()
}));

const app = require('../../server');
const hostProfileService = require('../../src/services/profiler/hostProfileService');
const modelProfileService = require('../../src/services/profiler/modelProfileService');

describe('Profiler Routes', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/profiler/dashboard', () => {
        it('should return dashboard data', async () => {
            hostProfileService.getAll.mockResolvedValue([
                { hostId: 'host-a', status: 'online' }
            ]);
            modelProfileService.getReadinessFunnel.mockResolvedValue({
                available: 3,
                profiled: 2,
                benchmarked: 1
            });
            modelProfileService.getStalenessReport.mockResolvedValue([
                { modelName: 'llama3.1:8b', hostId: 'host-a' }
            ]);
            modelProfileService.getBenchmarkedModelNames.mockResolvedValue([
                'gemma3:12b'
            ]);

            const response = await request(app).get('/api/profiler/dashboard');

            expect(response.status).toBe(200);
            expect(response.body.data).toEqual({
                hosts: [{ hostId: 'host-a', status: 'online' }],
                funnel: {
                    available: 3,
                    profiled: 2,
                    benchmarked: 1
                },
                staleProfiles: [{ modelName: 'llama3.1:8b', hostId: 'host-a' }],
                benchmarkedModels: ['gemma3:12b']
            });
        });

        it('should lift dashboard funnel benchmarked count from benchmark results', async () => {
            hostProfileService.getAll.mockResolvedValue([]);
            modelProfileService.getReadinessFunnel.mockResolvedValue({
                available: 3,
                profiled: 0,
                benchmarked: 0
            });
            modelProfileService.getStalenessReport.mockResolvedValue([]);
            modelProfileService.getBenchmarkedModelNames.mockResolvedValue([
                'gemma3:12b',
                'phi4:14b'
            ]);

            const response = await request(app).get('/api/profiler/dashboard');

            expect(response.status).toBe(200);
            expect(response.body.data.funnel.benchmarked).toBe(2);
        });

        it('should return 500 when the dashboard query fails', async () => {
            hostProfileService.getAll.mockRejectedValue(new Error('host db unavailable'));

            const response = await request(app).get('/api/profiler/dashboard');

            expect(response.status).toBe(500);
            expect(response.body).toMatchObject({ error: 'host db unavailable' });
        });
    });
});
