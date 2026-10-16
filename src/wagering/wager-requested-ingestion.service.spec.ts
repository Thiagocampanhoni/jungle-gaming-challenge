import { createHash } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WagerRequestedIngestionService } from './wager-requested-ingestion.service.js';
import { WagerTransactionIntakeService } from './wager-transaction-intake-service.js';
import { WagerTransactionProcessor } from './wager-transaction.processor.service.js';
import { WagerTransactionType } from './entities/wager-transaction.entity.js';
import type { WagerTransactionRequestedEvent } from './wager-requested-event.js';

const event: WagerTransactionRequestedEvent = {
  type: 'WagerTransactionRequested',
  messageId: 'msg-sqs-123',
  occurredAt: '2026-10-16T09:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'external-123',
    idempotencyKey: 'provider-a:external-123',
    playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    walletId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionType.BET,
    money: { amount: '1.00', currency: 'BRL' },
  },
};

const rawBody = JSON.stringify(event);
let transactionManager: EntityManager;
let transactional: ReturnType<typeof vi.fn>;
let submitProvider: ReturnType<typeof vi.fn>;
let process: ReturnType<typeof vi.fn>;
let ingestion: WagerRequestedIngestionService;

beforeEach(() => {
  transactionManager = {} as EntityManager;
  transactional = vi.fn(async (callback: (tx: EntityManager) => Promise<unknown>) =>
    callback(transactionManager));
  submitProvider = vi.fn().mockResolvedValue({
    transactionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    status: 'RECEIVED',
    duplicate: false,
  });
  process = vi.fn().mockResolvedValue({ disposition: 'ACK', status: 'APPLIED' });

  ingestion = new WagerRequestedIngestionService(
    { transactional } as unknown as EntityManager,
    { submitProviderInTransaction: submitProvider } as unknown as WagerTransactionIntakeService,
    { processWithTransaction: process } as unknown as WagerTransactionProcessor,
  );
});

describe('External SQS atomic ingress', () => {
  it('uses one SQL transaction for intake, inbox receipt and financial processing', async () => {
    const result = await ingestion.receive(event, rawBody);
    expect(transactional).toHaveBeenCalledTimes(1);
    expect(submitProvider).toHaveBeenCalledWith(
      transactionManager,
      event.data,
      'provider-a:external-123',
    );
    expect(process).toHaveBeenCalledWith(
      transactionManager,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      {
        consumerName: 'wager-transaction-consumer',
        messageId: 'msg-sqs-123',
        payloadHash: createHash('sha256').update(rawBody).digest('hex'),
      },
    );
    expect(result).toEqual({
      disposition: 'ACK', status: 'APPLIED',
      transactionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      duplicate: false,
    });
  });

  it('preserves REJECTED as terminal and returns ACK after commit', async () => {
    process.mockResolvedValueOnce({ disposition: 'ACK', status: 'REJECTED' });
    await expect(ingestion.receive(event, rawBody)).resolves.toMatchObject({
      disposition: 'ACK', status: 'REJECTED',
    });
  });

  it('retries a pending reference with the existing inbox receipt', async () => {
    process.mockResolvedValueOnce({
      disposition: 'RETRY', status: 'PENDING_REFERENCE', reason: 'REFERENCE_NOT_FOUND',
    });
    await expect(ingestion.receive(event, rawBody)).resolves.toMatchObject({
      disposition: 'RETRY', reason: 'REFERENCE_NOT_FOUND',
    });
  });

  it('propagates conflicts without acknowledging the external message', async () => {
    submitProvider.mockRejectedValueOnce(new Error('INBOX_MESSAGE_CONFLICT'));
    await expect(ingestion.receive(event, rawBody))
      .rejects.toThrow('INBOX_MESSAGE_CONFLICT');
    expect(process).not.toHaveBeenCalled();
  });

  it('preserves transaction identity on idempotent replay', async () => {
    submitProvider.mockResolvedValueOnce({
      transactionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      status: 'APPLIED',
      duplicate: true,
    });
    process.mockResolvedValueOnce({ disposition: 'ACK', status: 'ALREADY_APPLIED' });
    await expect(ingestion.receive(event, rawBody)).resolves.toMatchObject({
      duplicate: true, status: 'ALREADY_APPLIED',
    });
  });
});
