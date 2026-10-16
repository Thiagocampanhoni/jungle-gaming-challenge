import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityManager } from '@mikro-orm/postgresql';
import { PendingReferenceRecoveryService } from './pending-reference-recovery.service.js';
import { WagerTransactionProcessor } from './wager-transaction.processor.service.js';

const TRANSACTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dueJob = {
  transactionId: TRANSACTION_ID,
  attempts: 0,
  expiresAt: '2035-01-01T00:00:00Z',
  wagerStatus: 'PENDING_REFERENCE',
};

let execute: ReturnType<typeof vi.fn>;
let process: ReturnType<typeof vi.fn>;
let reject: ReturnType<typeof vi.fn>;
let worker: PendingReferenceRecoveryService;

function sqlCalls() {
  return execute.mock.calls.map(([sql]) => String(sql));
}

beforeEach(() => {
  execute = vi.fn().mockResolvedValue(undefined);
  process = vi.fn();
  reject = vi.fn();
  const tx = { execute } as unknown as EntityManager;
  const em = {
    transactional: vi.fn(async (callback: (t: EntityManager) => Promise<unknown>) => callback(tx)),
  } as unknown as EntityManager;
  const processor = {
    processWithTransaction: process,
    rejectPendingReferenceInTransaction: reject,
  } as unknown as WagerTransactionProcessor;
  worker = new PendingReferenceRecoveryService(em, processor);
});

describe('PendingReferenceRecoveryService', () => {
  it('does nothing when no job is due and uses the wager row SKIP LOCKED', async () => {
    execute.mockResolvedValueOnce([]);
    expect(await worker.runOnce()).toEqual({ action: 'IDLE' });
    expect(sqlCalls()[0]).toContain('FOR UPDATE OF wt SKIP LOCKED');
    expect(process).not.toHaveBeenCalled();
  });

  it('resolves after the missing reference arrives, atomically marks Inbox processed', async () => {
    execute.mockResolvedValueOnce([dueJob]);
    process.mockResolvedValueOnce({ disposition: 'ACK', status: 'APPLIED' });
    expect(await worker.runOnce()).toEqual({ action: 'RESOLVED', transactionId: TRANSACTION_ID });
    expect(sqlCalls()).toEqual(expect.arrayContaining([
      expect.stringContaining('UPDATE public.inbox_messages'),
      expect.stringContaining('UPDATE public.pending_reference_jobs'),
    ]));
    expect(process).toHaveBeenCalledOnce();
  });

  it('keeps an unresolved job pending with exponential backoff', async () => {
    execute.mockResolvedValueOnce([dueJob]);
    process.mockResolvedValueOnce({
      disposition: 'RETRY', status: 'PENDING_REFERENCE', reason: 'REFERENCE_NOT_FOUND',
    });
    expect(await worker.runOnce()).toEqual({
      action: 'RETRY', transactionId: TRANSACTION_ID, reason: 'REFERENCE_NOT_FOUND',
    });
    expect(execute.mock.lastCall?.[1]).toEqual([1, 16, 'REFERENCE_NOT_FOUND', TRANSACTION_ID]);
    expect(sqlCalls().some((sql) => sql.includes('UPDATE public.inbox_messages'))).toBe(false);
  });

  it('rejects an expired reference and ACKs Inbox within the same SQL transaction', async () => {
    execute.mockResolvedValueOnce([{ ...dueJob, expiresAt: '2000-01-01T00:00:00Z' }]);
    reject.mockResolvedValueOnce('REJECTED');
    expect(await worker.runOnce()).toEqual({
      action: 'REJECTED', transactionId: TRANSACTION_ID, reason: 'REFERENCE_EXPIRED',
    });
    expect(reject).toHaveBeenCalledWith(expect.anything(), TRANSACTION_ID, 'REFERENCE_EXPIRED');
    expect(process).not.toHaveBeenCalled();
    expect(sqlCalls().some((sql) => sql.includes('UPDATE public.inbox_messages'))).toBe(true);
  });

  it('rejects after exhausting the retry limit', async () => {
    execute.mockResolvedValueOnce([{ ...dueJob, attempts: 20 }]);
    reject.mockResolvedValueOnce('REJECTED');
    const result = await worker.runOnce();
    expect(result).toMatchObject({ action: 'REJECTED', reason: 'REFERENCE_RETRY_EXHAUSTED' });
  });

  it('finishes a job completed by an SQS redelivery without re-applying the ledger', async () => {
    execute.mockResolvedValueOnce([{ ...dueJob, wagerStatus: 'APPLIED' }]);
    expect(await worker.runOnce()).toMatchObject({ action: 'RESOLVED' });
    expect(process).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it('does not re-process a previously rejected transaction', async () => {
    execute.mockResolvedValueOnce([{ ...dueJob, wagerStatus: 'REJECTED' }]);
    expect(await worker.runOnce()).toMatchObject({ action: 'REJECTED' });
    expect(process).not.toHaveBeenCalled();
  });

  it('handles business-rule rejection from the processor without wallet side effects', async () => {
    execute.mockResolvedValueOnce([dueJob]);
    process.mockResolvedValueOnce({ disposition: 'ACK', status: 'REJECTED' });
    expect(await worker.runOnce()).toMatchObject({ action: 'REJECTED' });
    expect(sqlCalls().some((sql) => sql.includes('UPDATE public.inbox_messages'))).toBe(true);
  });

  it('refuses an invalid expiry rather than silently rejecting financial data', async () => {
    execute.mockResolvedValueOnce([{ ...dueJob, expiresAt: 'invalid' }]);
    await expect(worker.runOnce()).rejects.toThrow('INVALID_PENDING_REFERENCE_EXPIRY');
    expect(process).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });
});
