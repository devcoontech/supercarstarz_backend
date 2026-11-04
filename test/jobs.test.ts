import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/core/config.js';
import { app, resetDb } from './helpers.js';

describe('GET /internal/run-jobs', () => {
  let a: FastifyInstance;
  beforeAll(async () => {
    await resetDb();
    a = await app();
  });
  afterEach(() => {
    config.cronSecret = '';
  });
  afterAll(() => a.close());

  it('does not exist when CRON_SECRET is unset', async () => {
    const r = await a.inject({ method: 'GET', url: '/internal/run-jobs', headers: { authorization: 'Bearer ' } });
    expect(r.statusCode).toBe(404);
  });

  it('rejects a missing or wrong secret', async () => {
    config.cronSecret = 'right-secret';
    expect((await a.inject({ method: 'GET', url: '/internal/run-jobs' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/internal/run-jobs', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
  });

  it('runs the jobs with the right secret', async () => {
    config.cronSecret = 'right-secret';
    const r = await a.inject({ method: 'GET', url: '/internal/run-jobs', headers: { authorization: 'Bearer right-secret' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ expiredHolds: 0, remindersQueued: 0, emails: { sent: 0 } });
  });
});
