import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ServiceUnavailableException } from '@nestjs/common';

const sdk = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = sdk.send;
    destroy = sdk.destroy;
  },
  GetQueueAttributesCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

import { HealthService } from './health.service.js';

const COMMAND_URL = 'http://localhost:4566/000000000000/commands.fifo';
const EVENTS_URL = 'http://localhost:4566/000000000000/events.fifo';

function setup(withEvents = true) {
  const execute = vi.fn().mockResolvedValue([{ ok: 1 }]);
  const em = { execute } as unknown as EntityManager;
  const config = {
    getOrThrow: (key: string) => key === 'SQS_QUEUE_URL' ? COMMAND_URL : undefined,
    get: (key: string) => {
      if (key === 'SQS_EVENTS_QUEUE_URL') return withEvents ? EVENTS_URL : undefined;
      if (key === 'AWS_REGION') return 'us-east-1';
      if (key === 'AWS_ENDPOINT_URL') return 'http://localhost:4566';
      return undefined;
    },
  } as unknown as ConfigService;
  return { service: new HealthService(em, config), execute };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.send.mockResolvedValue({ Attributes: { QueueArn: 'arn:test' } });
});

describe('HealthService', () => {
  it('liveness does not probe PostgreSQL or SQS', () => {
    const { service, execute } = setup();
    expect(service.live()).toEqual({ status: 'ok' });
    expect(execute).not.toHaveBeenCalled();
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it('checks PostgreSQL and both configured SQS queues', async () => {
    const { service, execute } = setup();
    await expect(service.ready()).resolves.toEqual({
      status: 'ok',
      checks: { postgres: 'up', sqs: 'up' },
    });
    expect(execute).toHaveBeenCalledWith('SELECT 1 AS ok');
    expect(sdk.send).toHaveBeenCalledTimes(2);
    const urls = sdk.send.mock.calls.map(([command]) => command.input.QueueUrl);
    expect(urls).toEqual([COMMAND_URL, EVENTS_URL]);
  });

  it('returns HTTP 503 when PostgreSQL is unavailable', async () => {
    const { service, execute } = setup();
    execute.mockRejectedValueOnce(new Error('secret DB connection failure'));
    await expect(service.ready()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'unavailable',
        checks: { postgres: 'down', sqs: 'up' },
      },
    });
  });

  it('returns HTTP 503 when SQS is unavailable without leaking credentials', async () => {
    const { service } = setup();
    sdk.send.mockRejectedValueOnce(new Error('secret SQS credential failure'));
    try {
      await service.ready();
      throw new Error('Expected a ServiceUnavailableException');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const response = (error as ServiceUnavailableException).getResponse();
      expect(response).toEqual({
        status: 'unavailable',
        checks: { postgres: 'up', sqs: 'down' },
      });
      expect(JSON.stringify(response)).not.toContain('secret');
    }
  });

  it('checks only commands queue when events queue is not configured', async () => {
    const { service } = setup(false);
    await service.ready();
    expect(sdk.send).toHaveBeenCalledTimes(1);
  });

  it('destroys its SQS client during module shutdown', () => {
    const { service } = setup();
    service.onModuleDestroy();
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });
});
