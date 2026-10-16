import { describe, beforeEach, expect, it, vi } from 'vitest';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionProcessor } from './wager-transaction.processor.service.js';

const TRANSACTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECEIPT = {
  consumerName: 'wager-transaction-consumer',
  messageId: 'outbox-message-001',
  payloadHash: 'a'.repeat(64),
};

let execute: ReturnType<typeof vi.fn>;
let processor: WagerTransactionProcessor;

function arrange(...responses: unknown[]): void {
  for (const response of responses) {
    execute.mockResolvedValueOnce(response);
  }
}

beforeEach(() => {
  execute = vi.fn();
  const tx = { execute } as unknown as EntityManager;
  const em = {
    transactional: vi.fn(async (callback: (manager: EntityManager) => Promise<unknown>) => callback(tx)),
  } as unknown as EntityManager;
  processor = new WagerTransactionProcessor(em);
});

describe('persistent SQS inbox', () => {
  it('records the receipt in the financial SQL transaction and marks it processed on ACK', async () => {
    arrange(
      [{ messageId: RECEIPT.messageId }],
      [{ id: TRANSACTION_ID, status: 'APPLIED' }],
      undefined,
    );
    const result = await processor.process(TRANSACTION_ID, RECEIPT);
    expect(result).toEqual({ disposition: 'ACK', status: 'ALREADY_APPLIED' });
    expect(String(execute.mock.calls[0]?.[0])).toContain('INSERT INTO public.inbox_messages');
    expect(String(execute.mock.calls[2]?.[0])).toContain('SET processed_at = now()');
    expect(execute.mock.calls[2]?.[1]).toEqual([RECEIPT.consumerName, RECEIPT.messageId]);
  });

  it('acknowledges a duplicate logical message without processing the transaction again', async () => {
    arrange(
      [],
      [{ transactionId: TRANSACTION_ID, payloadHash: RECEIPT.payloadHash, processedAt: new Date() }],
    );
    const result = await processor.process(TRANSACTION_ID, RECEIPT);
    expect(result).toEqual({ disposition: 'ACK', status: 'ALREADY_APPLIED' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(String(execute.mock.calls[1]?.[0])).toContain('FOR UPDATE');
  });

  it('rejects reuse of the same message identity with different content', async () => {
    arrange(
      [],
      [{ transactionId: TRANSACTION_ID, payloadHash: 'b'.repeat(64), processedAt: new Date() }],
    );
    await expect(processor.process(TRANSACTION_ID, RECEIPT))
      .rejects.toThrow('INBOX_MESSAGE_CONFLICT');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('leaves a pending reference receipt unprocessed so redelivery can retry', async () => {
    arrange(
      [{ messageId: RECEIPT.messageId }],
      [{
        id: TRANSACTION_ID,
        walletId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        providerId: 'provider-a',
        playerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        roundId: 'round-1',
        type: 'REFUND',
        amount: '1.00',
        currency: 'BRL',
        referenceTransactionId: 'original-not-yet-delivered',
        status: 'RECEIVED',
      }],
      [],
      undefined,
    );
    const result = await processor.process(TRANSACTION_ID, RECEIPT);
    expect(result).toEqual({
      disposition: 'RETRY',
      status: 'PENDING_REFERENCE',
      reason: 'REFERENCE_NOT_FOUND',
    });
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('SET processed_at = now()'))).toBe(false);
  });
});
