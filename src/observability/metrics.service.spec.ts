import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ServiceUnavailableException } from '@nestjs/common';

const sdk = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = sdk.send; destroy = sdk.destroy },
  GetQueueAttributesCommand: class {
    readonly kind = 'attributes';
    constructor(public input: Record<string, unknown>) {}
  },
  GetQueueUrlCommand: class {
    readonly kind = 'url';
    constructor(public input: Record<string, unknown>) {}
  },
}));

import { MetricsService } from './metrics.service.js';
import { RuntimeMetricsService } from './runtime-metrics.service.js';

const COMMANDS = 'http://localhost:4566/000000000000/commands.fifo';
const EVENTS = 'http://localhost:4566/000000000000/events.fifo';
const DLQ = 'http://localhost:4566/000000000000/commands-dlq.fifo';
const config = {
  getOrThrow: () => COMMANDS,
  get: (name: string) => {
    if (name === 'SQS_EVENTS_QUEUE_URL') return EVENTS;
    if (name === 'AWS_REGION') return 'us-east-1';
    if (name === 'AWS_ENDPOINT_URL') return 'http://localhost:4566';
    return undefined;
  },
} as unknown as ConfigService;

function makeService() {
  const execute = vi.fn((sql: string): unknown => {
    if (sql.includes('FROM public.wager_transactions GROUP BY status')) {
      return [{ status: 'APPLIED', total: 2 }, { status: 'REJECTED', total: 1 }];
    }
    if (sql.includes('FROM public.outbox_messages GROUP BY status')) return [{ status: 'PENDING', total: 3 }];
    if (sql.includes('FROM public.pending_reference_jobs GROUP BY status')) return [{ status: 'RESOLVED', total: 1 }];
    if (sql.includes('FROM public.inbox_messages')) return [{ total: 1 }];
    if (sql.includes('FROM public.pending_reference_jobs')) return [{ totalAttempts: 2 }];
    if (sql.includes('FROM public.wager_transactions WHERE processed_at')) {
      return [{ averageSeconds: 0.5, maximumSeconds: 1.25 }];
    }
    if (sql.includes('FROM public.outbox_messages')) return [{ lagSeconds: 9.5 }];
    throw new Error('Unknown SQL');
  });
  const db = { execute } as unknown as EntityManager;
  const runtime = new RuntimeMetricsService();
  return { service: new MetricsService(db, config, runtime), runtime, execute };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.send.mockImplementation(async (command: { kind: string; input: { QueueUrl?: string } }) => {
    if (command.kind === 'url') return { QueueUrl: DLQ };
    if (command.input.QueueUrl === COMMANDS) return {
      Attributes: {
        ApproximateNumberOfMessages: '2',
        ApproximateNumberOfMessagesNotVisible: '0',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: 'arn:aws:sqs:us-east-1:000000000000:commands-dlq.fifo' }),
      },
    };
    if (command.input.QueueUrl === DLQ) return { Attributes: {
      ApproximateNumberOfMessages: '3',
      ApproximateNumberOfMessagesNotVisible: '1',
    } };
    return { Attributes: {
      ApproximateNumberOfMessages: '7',
      ApproximateNumberOfMessagesNotVisible: '0',
    } };
  });
});

describe('MetricsService Prometheus exporter', () => {
  it('exports database gauges, SQS/DLQ counts and local counters without IDs', async () => {
    const { service, runtime } = makeService();
    runtime.acknowledged(true);
    runtime.retryScheduled();
    const metrics = await service.collect();
    expect(metrics).toContain('# TYPE jungle_wager_transactions gauge');
    expect(metrics).toContain('jungle_wager_transactions{status="APPLIED"} 2');
    expect(metrics).toContain('jungle_pending_reference_jobs{status="RESOLVED"} 1');
    expect(metrics).toContain('jungle_inbox_unprocessed 1');
    expect(metrics).toContain('jungle_outbox_oldest_unpublished_age_seconds 9.5');
    expect(metrics).toContain('jungle_wager_completion_latency_seconds{stat="maximum"} 1.25');
    expect(metrics).toContain('jungle_sqs_messages{queue="events",state="available"} 7');
    expect(metrics).toContain('jungle_sqs_dlq_messages{queue="commands",state="available"} 3');
    expect(metrics).toContain('jungle_sqs_dlq_configured{queue="events"} 0');
    expect(metrics).toContain('jungle_consumer_duplicates_total 1');
    expect(metrics).toContain('jungle_consumer_retries_total 1');
    expect(metrics).not.toContain('cc519095-09bf-45c4-857a-5bb960e53f33');
    expect(metrics.endsWith('\n')).toBe(true);
  });

  it('does not alter database rows when scraped', async () => {
    const { service, execute } = makeService();
    await service.collect();
    expect(execute).toHaveBeenCalledTimes(7);
    expect(execute.mock.calls.every(([sql]) => String(sql).trim().startsWith('SELECT'))).toBe(true);
  });

  it('fails the scrape if an SQS queue is unavailable, without leaking endpoints', async () => {
    const { service } = makeService();
    sdk.send.mockRejectedValueOnce(new Error('localstack secret connection error'));
    await expect(service.collect()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects unknown database statuses rather than producing uncontrolled labels', async () => {
    const { service, execute } = makeService();
    execute.mockImplementation((sql: string) => {
      if (sql.includes('FROM public.wager_transactions GROUP BY status')) {
        return [{ status: 'unexpected"label', total: 10 }];
      }
      return [];
    });
    await expect(service.collect()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('releases the SQS connection when Nest shuts down', () => {
    const { service } = makeService();
    service.onModuleDestroy();
    expect(sdk.destroy).toHaveBeenCalledOnce();
  });
});
