import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  enqueueIntegrationEvent,
  type WagerEventData,
} from './integration-events.js';

const TX = '11111111-1111-4111-8111-111111111111';
const WALLET = '22222222-2222-4222-8222-222222222222';
const DATE = new Date('2026-10-16T12:00:00.000Z');
const data: WagerEventData = {
  transactionId: TX,
  providerId: 'provider-a',
  externalTransactionId: 'provider-001',
  playerId: '33333333-3333-4333-8333-333333333333',
  walletId: WALLET,
  roundId: 'round-7',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
};
const context = {
  eventId: '44444444-4444-4444-8444-444444444444',
  aggregateId: WALLET,
  correlationId: TX,
  causationId: 'provider-001',
  occurredAt: DATE,
};

describe('versioned domain event envelopes', () => {
  it('serializes WagerTransactionProcessed as ISO-8601 JSON', () => {
    const event = new WagerTransactionProcessed({ ...context, data });
    expect(event.toJSON()).toEqual({
      eventId: context.eventId,
      eventType: 'WagerTransactionProcessed',
      version: 1,
      aggregateId: WALLET,
      correlationId: TX,
      causationId: 'provider-001',
      occurredAt: '2026-10-16T12:00:00.000Z',
      data,
    });
    expect(JSON.stringify(event)).toContain('"amount":"10.00"');
  });

  it('serializes rejection with a failure code', () => {
    const event = new WagerTransactionRejected({
      ...context,
      data: { ...data, failureCode: 'INSUFFICIENT_FUNDS' },
    });
    expect(event.toJSON().eventType).toBe('WagerTransactionRejected');
    expect(event.toJSON().data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('serializes a wallet change with old and new balances and version', () => {
    const event = new WalletBalanceChanged({
      ...context,
      data: {
        walletId: WALLET, transactionId: TX, direction: 'DEBIT',
        money: data.money,
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(event.toJSON().eventType).toBe('WalletBalanceChanged');
    expect(event.toJSON().data.walletVersion).toBe(2);
  });

  it('serializes pending reference without mutating the wager amount', () => {
    const event = new WagerTransactionPendingReference({
      ...context,
      data: { ...data, failureCode: 'REFERENCE_NOT_FOUND', referenceExternalTransactionId: 'old-bet' },
    });
    expect(event.toJSON().eventType).toBe('WagerTransactionPendingReference');
    expect(event.toJSON().data.money.amount).toBe('10.00');
  });

  it('persists into the existing SQL Outbox with a deterministic deduplication key', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const tx = { execute } as unknown as EntityManager;
    const first = new WagerTransactionProcessed({ ...context, data });
    const next = new WagerTransactionProcessed({ ...context, eventId: '55555555-5555-4555-8555-555555555555', data });
    await enqueueIntegrationEvent(tx, TX, first);
    await enqueueIntegrationEvent(tx, TX, next);
    expect(execute).toHaveBeenCalledTimes(2);
    const [query, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('ON CONFLICT (deduplication_key) DO NOTHING');
    expect(params[2]).toBe(createHash('sha256').update(`${TX}:WagerTransactionProcessed:v1`).digest('hex'));
    expect(params[2]).toBe(execute.mock.calls[1]?.[1]?.[2]);
    expect(JSON.parse(String(params[4])).eventId).toBe(context.eventId);
  });
});
