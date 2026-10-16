import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { describe, expect, it, vi } from 'vitest';
import { WagerTransactionQueryService } from './wager-transaction-query.service.js';

const row = {
  transactionId: '11111111-1111-4111-8111-111111111111',
  providerId: 'provider-a',
  externalTransactionId: 'bet-123',
  playerId: '22222222-2222-4222-8222-222222222222',
  walletId: '33333333-3333-4333-8333-333333333333',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  amount: '80.00',
  currency: 'BRL',
  referenceExternalTransactionId: null,
  status: 'APPLIED',
  errorCode: null,
  createdAt: new Date('2026-10-16T12:00:00.000Z'),
  processedAt: new Date('2026-10-16T12:00:01.000Z'),
};

function makeService(results: object[] = [row]) {
  const execute = vi.fn().mockResolvedValue(results);
  const service = new WagerTransactionQueryService(
    { execute } as unknown as EntityManager,
  );
  return { service, execute };
}

describe('WagerTransactionQueryService', () => {
  it('returns the public contract without internal keys', async () => {
    const { service, execute } = makeService();
    const result = await service.findById(row.transactionId);
    expect(result).toEqual({
      transactionId: row.transactionId,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      playerId: row.playerId,
      walletId: row.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
      status: 'PROCESSED',
      failureCode: null,
      createdAt: '2026-10-16T12:00:00.000Z',
      processedAt: '2026-10-16T12:00:01.000Z',
    });
    expect(execute.mock.calls[0][1]).toEqual([row.transactionId]);
  });

  it('queries provider and external id as SQL parameters', async () => {
    const { service, execute } = makeService();
    await service.findByProviderExternalId('provider-a', 'bet-123');
    expect(execute.mock.calls[0][1]).toEqual(['provider-a', 'bet-123']);
    expect(execute.mock.calls[0][0]).toContain('wt.provider_id = ?');
  });

  it('returns 404 for missing transaction', async () => {
    const { service } = makeService([]);
    await expect(service.findById(row.transactionId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps a rejection with its failure code and null processedAt', async () => {
    const { service } = makeService([{
      ...row,
      status: 'REJECTED',
      errorCode: 'INSUFFICIENT_FUNDS',
      processedAt: null,
    }]);
    const result = await service.findById(row.transactionId);
    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.processedAt).toBeNull();
  });

  it('preserves PENDING_REFERENCE and its nonterminal reason code', async () => {
    const { service } = makeService([{
      ...row,
      status: 'PENDING_REFERENCE',
      errorCode: 'REFERENCE_NOT_FOUND',
      referenceExternalTransactionId: 'missing-original',
    }]);
    const result = await service.findById(row.transactionId);
    expect(result.status).toBe('PENDING_REFERENCE');
    expect(result.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(result.referenceExternalTransactionId).toBe('missing-original');
  });

  it.each(['', '   ', 'x'.repeat(129)])(
    'rejects invalid providerId %j before querying the database',
    async (invalidProviderId) => {
      const { service, execute } = makeService();
      await expect(
        service.findByProviderExternalId(invalidProviderId, 'bet-123'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   ', 'x'.repeat(129)])(
    'rejects invalid externalTransactionId %j before querying the database',
    async (invalidExternalId) => {
      const { service, execute } = makeService();
      await expect(
        service.findByProviderExternalId('provider-a', invalidExternalId),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
