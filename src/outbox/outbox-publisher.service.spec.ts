import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { ConfigService } from '@nestjs/config';

const sdk = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = sdk.send;
    destroy = sdk.destroy;
  },
  SendMessageCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

import { OutboxPublisherService } from './outbox-publisher.service.js';

const COMMAND_QUEUE = 'http://localhost:4566/000000000000/commands.fifo';
const EVENT_QUEUE = 'http://localhost:4566/000000000000/events.fifo';
const WALLET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BASE = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  deduplicationKey: 'dedup-001',
  eventType: 'WAGER_TRANSACTION_RECEIVED',
  payload: { transactionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
  attempts: 1,
  walletId: WALLET,
};

function makePublisher(message: Record<string, unknown>, withEvents = true) {
  const txExecute = vi.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ ...BASE, ...message }]);
  const execute = vi.fn().mockResolvedValue([]);
  const em = {
    execute,
    transactional: vi.fn(async (fn: (tx: EntityManager) => Promise<unknown>) =>
      fn({ execute: txExecute } as unknown as EntityManager)),
  } as unknown as EntityManager;
  const config = {
    getOrThrow: (key: string) => key === 'SQS_QUEUE_URL' ? COMMAND_QUEUE : undefined,
    get: (key: string) => {
      if (key === 'SQS_EVENTS_QUEUE_URL') return withEvents ? EVENT_QUEUE : undefined;
      if (key === 'AWS_REGION') return 'us-east-1';
      if (key === 'AWS_ENDPOINT_URL') return 'http://localhost:4566';
      return undefined;
    },
  } as unknown as ConfigService;
  return { publisher: new OutboxPublisherService(em, config), txExecute, execute };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.send.mockResolvedValue({ MessageId: 'transport-001' });
});

describe('OutboxPublisherService queue separation', () => {
  it('keeps the established HTTP receive command envelope in the commands FIFO', async () => {
    const { publisher } = makePublisher({});
    expect(await publisher.publishBatch()).toBe(1);
    const command = sdk.send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input.QueueUrl).toBe(COMMAND_QUEUE);
    expect(command.input.MessageGroupId).toBe(WALLET);
    expect(JSON.parse(String(command.input.MessageBody))).toMatchObject({
      eventType: 'WAGER_TRANSACTION_RECEIVED',
      outboxId: BASE.id,
      payload: BASE.payload,
    });
  });

  it('publishes domain events directly to a separate events FIFO', async () => {
    const payload = {
      eventId: BASE.id,
      eventType: 'WagerTransactionProcessed',
      version: 1,
      aggregateId: WALLET,
      correlationId: 'reference',
      occurredAt: '2026-10-16T12:00:00.000Z',
      data: { money: { amount: '1.00', currency: 'BRL' } },
    };
    const { publisher, execute } = makePublisher({
      eventType: 'WagerTransactionProcessed', payload,
    });
    expect(await publisher.publishBatch()).toBe(1);
    const command = sdk.send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input.QueueUrl).toBe(EVENT_QUEUE);
    expect(command.input.MessageDeduplicationId).toBe(BASE.deduplicationKey);
    expect(JSON.parse(String(command.input.MessageBody))).toEqual(payload);
    expect(String(execute.mock.calls[0]?.[0])).toContain("status = 'PUBLISHED'");
  });

  it('never claims domain events when the events queue is not configured', async () => {
    const { publisher, txExecute } = makePublisher({}, false);
    await publisher.publishBatch();
    const sql = String(txExecute.mock.calls[1]?.[0]);
    const params = txExecute.mock.calls[1]?.[1] as unknown[];
    expect(sql).toContain("event_type = 'WAGER_TRANSACTION_RECEIVED'");
    expect(params[1]).toBe(false);
  });

  it('refuses a events queue URL equal to the incoming commands queue', () => {
    const manager = {} as EntityManager;
    const config = {
      getOrThrow: () => COMMAND_QUEUE,
      get: (key: string) => key === 'SQS_EVENTS_QUEUE_URL' ? COMMAND_QUEUE : undefined,
    } as unknown as ConfigService;
    expect(() => new OutboxPublisherService(manager, config)).toThrow('must differ');
  });
});
