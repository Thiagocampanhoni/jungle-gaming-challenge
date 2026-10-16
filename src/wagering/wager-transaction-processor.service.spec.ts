import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionProcessor } from './wager-transaction.processor.service.js';

const WALLET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRANSACTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LEDGER_ENTRY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PLAYER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROVIDER_ID = 'provider-a';

const baseWager = {
  id: TRANSACTION_ID,
  walletId: WALLET_ID,
  externalTransactionId: 'external-bet-001',
  providerId: PROVIDER_ID,
  playerId: PLAYER_ID,
  roundId: 'round-123',
  type: 'BET',
  amount: '10.00',
  currency: 'BRL',
  referenceTransactionId: null as string | null,
  status: 'RECEIVED',
};

let executeMock: ReturnType<typeof vi.fn>;
let processor: WagerTransactionProcessor;

function queueExecuteResults(...results: unknown[]): void {
  for (const result of results) {
    executeMock.mockResolvedValueOnce(result);
  }
}

function sqlAt(index: number): string {
  return String(executeMock.mock.calls[index]?.[0] ?? '');
}

function expectRejectedWith(errorCode: string): void {
  const rejectCall = executeMock.mock.calls.find(([sql]) =>
    String(sql).includes("SET status = 'REJECTED'"),
  );

  expect(rejectCall).toBeDefined();
  expect(rejectCall?.[1]).toEqual([errorCode, TRANSACTION_ID]);
  expect(
    executeMock.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO public.ledger_entries'),
    ),
  ).toBe(false);
}

function integrationEvents() {
  return executeMock.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO public.outbox_messages'))
    .map(([, params]) => JSON.parse(String(params?.[4])) as {
      eventType: string;
      data: Record<string, unknown>;
    });
}

function referenceRow(
  type: 'BET' | 'WIN' | 'LOSS' | 'REFUND',
  direction: 'DEBIT' | 'CREDIT' | null,
) {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    walletId: WALLET_ID,
    providerId: PROVIDER_ID,
    playerId: PLAYER_ID,
    roundId: 'round-123',
    type,
    status: 'APPLIED',
    currency: 'BRL',
    ledgerEntryId: direction ? LEDGER_ENTRY_ID : null,
    ledgerDirection: direction,
    ledgerAmount: direction ? '10.00' : null,
  };
}

beforeEach(() => {
  executeMock = vi.fn();

  const tx = {
    execute: executeMock,
  } as unknown as EntityManager;

  const em = {
    transactional: vi.fn(
      async (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback(tx),
    ),
  } as unknown as EntityManager;

  processor = new WagerTransactionProcessor(em);
});

describe('WagerTransactionProcessor', () => {
  it('returns NOT_FOUND when the transaction does not exist', async () => {
    queueExecuteResults([]);

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({
      disposition: 'RETRY',
      status: 'NOT_FOUND',
      reason: 'TRANSACTION_NOT_FOUND',
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('does not process a transaction that is already applied', async () => {
    queueExecuteResults([{ ...baseWager, status: 'APPLIED' }]);

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({
      disposition: 'ACK',
      status: 'ALREADY_APPLIED',
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('debits a wallet and records a ledger entry for a BET', async () => {
    queueExecuteResults(
      [baseWager],
      [{ id: WALLET_ID, balance: '100.00', currency: 'BRL', version: 1 }],
      undefined,
      undefined,
      undefined,
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({
      disposition: 'ACK',
      status: 'APPLIED',
    });
    expect(executeMock).toHaveBeenCalledTimes(7);
    expect(sqlAt(2)).toContain('UPDATE public.wallets');
    expect(sqlAt(3)).toContain('INSERT INTO public.ledger_entries');
    expect(executeMock.mock.calls[2]?.[1]).toEqual(['90.00', WALLET_ID]);
  });

  it('rejects a BET when funds are insufficient without changing the balance', async () => {
    queueExecuteResults(
      [baseWager],
      [{ id: WALLET_ID, balance: '5.00', currency: 'BRL', version: 1 }],
      undefined,
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({
      disposition: 'ACK',
      status: 'REJECTED',
    });
    expect(sqlAt(2)).toContain('UPDATE public.wager_transactions');
    expect(
      executeMock.mock.calls.some(([query]) =>
        String(query).includes('UPDATE public.wallets'),
      ),
    ).toBe(false);
    expect(
      executeMock.mock.calls.some(([query]) =>
        String(query).includes('INSERT INTO public.ledger_entries'),
      ),
    ).toBe(false);
  });

  it('marks a transaction as pending when its reference is missing', async () => {
    const refund = {
      ...baseWager,
      type: 'REFUND',
      referenceTransactionId: 'external-bet-missing',
    };

    queueExecuteResults([refund], [], undefined);

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({
      disposition: 'RETRY',
      status: 'PENDING_REFERENCE',
      reason: 'REFERENCE_NOT_FOUND',
    });
    expect(executeMock).toHaveBeenCalledTimes(5);
    expect(sqlAt(1)).toContain('wt.provider_id = ?');
    expect(sqlAt(3)).toContain('INSERT INTO public.pending_reference_jobs');
    expect(executeMock.mock.calls[1]?.[1]).toEqual([
      PROVIDER_ID,
      'external-bet-missing',
    ]);
  });

  it('rejects a second reversal of the same ledger entry', async () => {
    const rollback = {
      ...baseWager,
      type: 'ROLLBACK',
      referenceTransactionId: 'external-bet-original',
    };

    const original = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      walletId: WALLET_ID,
      providerId: PROVIDER_ID,
      playerId: PLAYER_ID,
      roundId: 'round-123',
      type: 'BET',
      status: 'APPLIED',
      ledgerEntryId: LEDGER_ENTRY_ID,
      ledgerDirection: 'DEBIT' as const,
      ledgerAmount: '10.00',
      currency: 'BRL',
    };

    queueExecuteResults(
      [rollback],
      [original],
      [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }],
      undefined,
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({
      disposition: 'ACK',
      status: 'REJECTED',
    });
    expect(sqlAt(3)).toContain('UPDATE public.wager_transactions');
    expect(
      executeMock.mock.calls.some(([query]) =>
        String(query).includes('UPDATE public.wallets'),
      ),
    ).toBe(false);
    expect(
      executeMock.mock.calls.some(([query]) =>
        String(query).includes('INSERT INTO public.ledger_entries'),
      ),
    ).toBe(false);
  });

  it('REFUND accepts an applied BET and creates a compensating CREDIT', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'REFUND', referenceTransactionId: 'bet-1' }],
      [referenceRow('BET', 'DEBIT')],
      [], // No previous reversal of the referenced ledger entry
      [{ id: WALLET_ID, balance: '90.00', currency: 'BRL', version: 1 }],
      undefined, // UPDATE wallet
      undefined, // INSERT ledger entry
      undefined, // UPDATE transaction status
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({ disposition: 'ACK', status: 'APPLIED' });
    expect(executeMock).toHaveBeenCalledTimes(9);
    expect(executeMock.mock.calls[4]?.[1]).toEqual(['100.00', WALLET_ID]);
    expect(sqlAt(5)).toContain('INSERT INTO public.ledger_entries');
    expect(executeMock.mock.calls[5]?.[1]?.slice(3, 6)).toEqual([
      'CREDIT',
      '10.00',
      LEDGER_ENTRY_ID,
    ]);
  });

  it('REFUND rejects a WIN even if it is APPLIED and has a ledger entry', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'REFUND', referenceTransactionId: 'win-1' }],
      [referenceRow('WIN', 'CREDIT')],
      undefined, // UPDATE transaction to REJECTED
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({ disposition: 'ACK', status: 'REJECTED' });
    expectRejectedWith('REFERENCE_TYPE_NOT_ALLOWED');
    expect(executeMock).toHaveBeenCalledTimes(4);
  });

  it('ROLLBACK accepts a REFUND and reverses its CREDIT with a DEBIT', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'ROLLBACK', referenceTransactionId: 'refund-1' }],
      [referenceRow('REFUND', 'CREDIT')],
      [],
      [{ id: WALLET_ID, balance: '100.00', currency: 'BRL', version: 1 }],
      undefined, // UPDATE wallet
      undefined, // INSERT ledger entry
      undefined, // UPDATE transaction status
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({ disposition: 'ACK', status: 'APPLIED' });
    expect(executeMock.mock.calls[4]?.[1]).toEqual(['90.00', WALLET_ID]);
    expect(executeMock.mock.calls[5]?.[1]?.slice(3, 6)).toEqual([
      'DEBIT',
      '10.00',
      LEDGER_ENTRY_ID,
    ]);
  });

  it('ROLLBACK rejects LOSS as a non-reversible reference', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'ROLLBACK', referenceTransactionId: 'loss-1' }],
      [referenceRow('LOSS', null)],
      undefined,
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({ disposition: 'ACK', status: 'REJECTED' });
    expectRejectedWith('REFERENCE_TYPE_NOT_ALLOWED');
  });

  it('uses a distinct error when a ROLLBACK would make the wallet negative', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'ROLLBACK', referenceTransactionId: 'win-1' }],
      [referenceRow('WIN', 'CREDIT')],
      [],
      [{ id: WALLET_ID, balance: '5.00', currency: 'BRL', version: 1 }],
      undefined, // UPDATE transaction to REJECTED
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({ disposition: 'ACK', status: 'REJECTED' });
    expectRejectedWith('REVERSAL_INSUFFICIENT_FUNDS');
    expect(
      executeMock.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE public.wallets'),
      ),
    ).toBe(false);
  });

  it('rejects a reference in another currency before affecting the wallet', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'REFUND', referenceTransactionId: 'bet-usd' }],
      [{ ...referenceRow('BET', 'DEBIT'), currency: 'USD' }],
      undefined,
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({ disposition: 'ACK', status: 'REJECTED' });
    expectRejectedWith('REFERENCE_CURRENCY_MISMATCH');
  });


  it('rejects a REFUND whose reference belongs to another player', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'REFUND', referenceTransactionId: 'bet-other-player' }],
      [{ ...referenceRow('BET', 'DEBIT'), playerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }],
      undefined,
    );

    const result = await processor.process(TRANSACTION_ID);
    expect(result).toEqual({ disposition: 'ACK', status: 'REJECTED' });
    expectRejectedWith('REFERENCE_PLAYER_MISMATCH');
  });

  it('rejects a ROLLBACK whose reference is from another round', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'ROLLBACK', referenceTransactionId: 'bet-other-round' }],
      [{ ...referenceRow('BET', 'DEBIT'), roundId: 'another-round' }],
      undefined,
    );

    const result = await processor.process(TRANSACTION_ID);
    expect(result).toEqual({ disposition: 'ACK', status: 'REJECTED' });
    expectRejectedWith('REFERENCE_ROUND_MISMATCH');
  });

  it('processes LOSS without changing the wallet balance or creating a ledger entry', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'LOSS' }],
      [{ id: WALLET_ID, balance: '100.00', currency: 'BRL', version: 1 }],
      undefined,
    );

    const result = await processor.process(TRANSACTION_ID);

    expect(result).toEqual({
      disposition: 'ACK',
      status: 'APPLIED',
    });
    expect(executeMock).toHaveBeenCalledTimes(4);
    expect(
      executeMock.mock.calls.some(([query]) =>
        String(query).includes('UPDATE public.wallets'),
      ),
    ).toBe(false);
    expect(
      executeMock.mock.calls.some(([query]) =>
        String(query).includes('INSERT INTO public.ledger_entries'),
      ),
    ).toBe(false);
  });

  it('emits processed and balance-changed events for BET, inside SQL transaction', async () => {
    queueExecuteResults(
      [baseWager],
      [{ id: WALLET_ID, balance: '100.00', currency: 'BRL', version: 7 }],
      undefined, undefined, undefined, undefined, undefined,
    );
    await processor.process(TRANSACTION_ID);
    const events = integrationEvents();
    expect(events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);
    expect(events[1]?.data.walletVersion).toBe(8);
    expect(events[1]?.data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(events[1]?.data.balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
  });

  it('emits processed only for LOSS, without WalletBalanceChanged', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'LOSS' }],
      [{ id: WALLET_ID, balance: '100.00', currency: 'BRL', version: 2 }],
      undefined,
    );
    await processor.process(TRANSACTION_ID);
    expect(integrationEvents().map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });

  it('emits rejection only when funds are insufficient', async () => {
    queueExecuteResults(
      [baseWager],
      [{ id: WALLET_ID, balance: '2.00', currency: 'BRL', version: 2 }],
      undefined,
    );
    await processor.process(TRANSACTION_ID);
    const events = integrationEvents();
    expect(events.map((event) => event.eventType)).toEqual(['WagerTransactionRejected']);
    expect(events[0]?.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('emits a pending-reference event without creating any ledger entry', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'REFUND', referenceTransactionId: 'not-yet-seen' }],
      [],
      undefined,
    );
    const result = await processor.process(TRANSACTION_ID);
    expect(result.disposition).toBe('RETRY');
    const events = integrationEvents();
    expect(events.map((event) => event.eventType)).toEqual(['WagerTransactionPendingReference']);
    expect(events[0]?.data.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(sqlAt(3)).toContain('INSERT INTO public.pending_reference_jobs');
  });

  it('does not emit events on redelivery of an already-applied transaction', async () => {
    queueExecuteResults([{ ...baseWager, status: 'APPLIED' }]);
    await processor.process(TRANSACTION_ID);
    expect(integrationEvents()).toEqual([]);
  });

  it('terminally rejects only a still-pending reference with an event', async () => {
    queueExecuteResults(
      [{ ...baseWager, type: 'REFUND', status: 'PENDING_REFERENCE', referenceTransactionId: 'missing' }],
    );
    const tx = { execute: executeMock } as unknown as EntityManager;
    const result = await processor.rejectPendingReferenceInTransaction(
      tx, TRANSACTION_ID, 'REFERENCE_EXPIRED',
    );
    expect(result).toBe('REJECTED');
    expectRejectedWith('REFERENCE_EXPIRED');
    expect(integrationEvents()[0]?.eventType).toBe('WagerTransactionRejected');
  });

  it('never terminally rejects a reference that was already applied', async () => {
    queueExecuteResults([{ ...baseWager, status: 'APPLIED' }]);
    const tx = { execute: executeMock } as unknown as EntityManager;
    const result = await processor.rejectPendingReferenceInTransaction(
      tx, TRANSACTION_ID, 'REFERENCE_EXPIRED',
    );
    expect(result).toBe('ALREADY_TERMINAL');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

});
