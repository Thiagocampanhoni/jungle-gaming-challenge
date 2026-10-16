import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletService } from './wallet.service.js';
import type { CreateWalletDto } from './dto/create-wallet.dto.js';

const walletId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const playerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const wallet = {
  id: walletId,
  playerId,
  balance: '100.00',
  currency: 'BRL',
  version: 1,
};

let execute: ReturnType<typeof vi.fn>;
let transactional: ReturnType<typeof vi.fn>;
let service: WalletService;

beforeEach(() => {
  execute = vi.fn();
  const tx = { execute } as unknown as EntityManager;
  transactional = vi.fn(async (callback: (manager: EntityManager) => Promise<unknown>) => callback(tx));
  const em = { execute, transactional } as unknown as EntityManager;
  service = new WalletService(em);
});

const makeCreate = (amount: string): CreateWalletDto => ({
  playerId,
  initialBalance: { amount, currency: 'BRL' },
});

function queue(...responses: unknown[]): void {
  for (const response of responses) execute.mockResolvedValueOnce(response);
}

describe('WalletService', () => {
  it('creates a funded wallet, OPENING transaction and ledger credit atomically', async () => {
    queue([wallet], undefined, undefined);
    const result = await service.create(makeCreate('100.00'));

    expect(result).toEqual({
      id: walletId,
      playerId,
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
    });
    expect(transactional).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(String(execute.mock.calls[1]?.[0])).toContain("'OPENING'");
    expect(String(execute.mock.calls[1]?.[0])).toContain("'internal'");
    expect(String(execute.mock.calls[2]?.[0])).toContain('INSERT INTO public.ledger_entries');
    expect(String(execute.mock.calls[2]?.[0])).toContain("'CREDIT'");
    expect(execute.mock.calls[2]?.[1]?.[3]).toBe('100.00');
  });

  it('creates a zero-balance wallet without an OPENING row', async () => {
    queue([{ ...wallet, balance: '0.00' }]);
    const result = await service.create(makeCreate('0.00'));
    expect(result.balance.amount).toBe('0.00');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate player/currency tuple', async () => {
    queue([]);
    await expect(service.create(makeCreate('100.00'))).rejects.toBeInstanceOf(ConflictException);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid initial amount in the service as well as the DTO', async () => {
    await expect(service.create(makeCreate('nope'))).rejects.toBeInstanceOf(BadRequestException);
    expect(transactional).not.toHaveBeenCalled();
  });

  it('returns exact decimal strings for a wallet', async () => {
    queue([wallet]);
    await expect(service.findOne(walletId)).resolves.toEqual({
      id: walletId,
      playerId,
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('responds with 404 for an unknown wallet', async () => {
    queue([]);
    await expect(service.findOne(walletId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns an opaque cursor and keeps pagination scoped to a wallet', async () => {
    queue([wallet], [
      {
        id: '11111111-1111-4111-8111-111111111111',
        transactionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        direction: 'CREDIT',
        amount: '100.00',
        reversesEntryId: null,
        cursorTimestamp: '2026-10-16T01:02:03.123456Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        transactionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        direction: 'DEBIT',
        amount: '1.00',
        reversesEntryId: null,
        cursorTimestamp: '2026-10-16T01:02:03.123455Z',
      },
    ]);
    const first = await service.ledger(walletId, '1');
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.money).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(first.nextCursor).toBeTruthy();
    execute.mockClear();
    queue([wallet], []);
    await service.ledger(walletId, '1', first.nextCursor!);
    expect(String(execute.mock.calls[1]?.[0])).toContain('le.created_at, le.id');
    expect(execute.mock.calls[1]?.[1]?.[1]).toBe('2026-10-16T01:02:03.123456Z');
  });

  it('rejects a cursor tied to a different wallet', async () => {
    const token = Buffer.from(JSON.stringify({
      walletId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      timestamp: '2026-10-16T01:02:03.123456Z',
      id: '11111111-1111-4111-8111-111111111111',
    })).toString('base64url');
    await expect(service.ledger(walletId, '5', token))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid pagination sizes', async () => {
    await expect(service.ledger(walletId, '101')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.ledger(walletId, '1.5')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reconciles the stored balance against the ledger', async () => {
    queue([wallet], [{ calculatedBalance: '100.00', checkedEntries: '3' }]);
    await expect(service.reconcile(walletId)).resolves.toEqual({
      walletId,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  it('reports a divergence without silently correcting balance', async () => {
    queue([wallet], [{ calculatedBalance: '99.50', checkedEntries: '3' }]);
    const result = await service.reconcile(walletId);
    expect(result.consistent).toBe(false);
    expect(result.difference).toEqual({ amount: '0.50', currency: 'BRL' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every((call) => String(call[0]).trimStart().startsWith('SELECT'))).toBe(true);
  });
});
