const request = require('supertest');

jest.mock('../../src/services/pipelineTaskService', () => ({
  createTaskInMongo: jest.fn(),
}));

const { createTaskInMongo } = require('../../src/services/pipelineTaskService');
const { app } = require('../../src/app');

describe('POST /api/todos', () => {
  beforeEach(() => {
    createTaskInMongo.mockReset();
  });

  test('creates a Mongo pipeline task through the legacy TODO endpoint', async () => {
    createTaskInMongo.mockResolvedValue({
      id: '0321',
      pipelineId: '0321',
      title: 'Probe the membrane',
      service: 'core',
      status: 'queued',
    });

    const payload = {
      title: 'Probe the membrane',
      objective: 'Create a worker-safe TODO from structured input.',
      service: 'core',
      short_name: 'probe-membrane',
      source_files: ['core/src/app.js'],
      steps: ['Read the app route table', 'Verify the endpoint'],
      constraints: ['Do not dispatch the task'],
      acceptance_criteria: ['The TODO file exists', 'The roadmap points to it'],
    };

    const res = await request(app)
      .post('/api/todos')
      .set('x-test-client', 'todos-api-create')
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data.task).toEqual({
      id: '0321',
      pipelineId: '0321',
      title: 'Probe the membrane',
      service: 'core',
      status: 'queued',
    });
    expect(createTaskInMongo).toHaveBeenCalledWith(payload);
  });

  test('surfaces task validation errors from Mongo pipeline creation', async () => {
    const err = new Error('service is required');
    err.status = 400;
    err.code = 'INVALID_TODO_INPUT';
    createTaskInMongo.mockRejectedValue(err);

    const res = await request(app)
      .post('/api/todos')
      .set('x-test-client', 'todos-api-invalid')
      .send({ objective: 'too little' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toBe('service is required');
    expect(res.body.code).toBe('INVALID_TODO_INPUT');
  });
});
