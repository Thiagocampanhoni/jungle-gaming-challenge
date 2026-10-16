import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthController', () => {
  const liveResponse = { status: 'ok' } as const;
  const readyResponse = {
    status: 'ok',
    checks: { postgres: 'up', sqs: 'up' },
  } as const;

  function createController(ready: () => Promise<typeof readyResponse>) {
    const service = {
      live: () => liveResponse,
      ready,
    } as unknown as HealthService;
    return new HealthController(service);
  }

  it('exposes independent process liveness', () => {
    const controller = createController(async () => readyResponse);
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('returns both PostgreSQL and SQS status on readiness', async () => {
    const controller = createController(async () => readyResponse);
    await expect(controller.ready()).resolves.toEqual(readyResponse);
  });

  it('preserves HTTP 503 for unavailable dependencies', async () => {
    const controller = createController(async () => {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        checks: { postgres: 'down', sqs: 'up' },
      });
    });
    await expect(controller.ready()).rejects.toMatchObject({ status: 503 });
  });
});
