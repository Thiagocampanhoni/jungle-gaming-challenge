import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WagerTransactionIntakeService } from './wager-transaction-intake-service.js';
import { WagerTransactionType } from './entities/wager-transaction.entity.js';
import { SubmitWageringTransactionDto } from './dto/submit-wagering-transaction.dto.js';
import type { CreateWagerTransactionDto } from './dto/create-wager-transaction.dto.js';

const walletId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const playerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const storedWallet = { id: walletId, playerId, currency: 'BRL' };

const providerSubmission: SubmitWageringTransactionDto = {
  providerId: 'provider-a',
  externalTransactionId: 'tx-123',
  playerId,
  walletId,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionType.BET,
  money: { amount: '1.00', currency: 'BRL' },
};

let execute: ReturnType<typeof vi.fn>;
let service: WagerTransactionIntakeService;

beforeEach(() => {
  execute = vi.fn();
  const tx = { execute } as unknown as EntityManager;
  const em = {
    transactional: vi.fn(async (cb: (manager: EntityManager) => Promise<unknown>) => cb(tx)),
  } as unknown as EntityManager;
  service = new WagerTransactionIntakeService(em);
});

function queue(...rows: unknown[]) {
  for (const row of rows) execute.mockResolvedValueOnce(row);
}

describe('WagerTransactionIntakeService', () => {
  it('persists provider identity and an outbox command in one transaction', async () => {
    queue([storedWallet], [{ id: 'new-id', status: 'RECEIVED' }], undefined);
    const result = await service.submitProvider(providerSubmission, 'provider-a:tx-123');

    expect(result).toEqual({ transactionId: 'new-id', status: 'RECEIVED', duplicate: false });
    const insertSql = String(execute.mock.calls[1]?.[0]);
    const params = execute.mock.calls[1]?.[1] as unknown[];
    expect(insertSql).toContain('provider_id');
    expect(insertSql).toContain('player_id');
    expect(params.slice(2, 8)).toEqual([
      'provider-a', playerId, 'round-1', 'game-1', 'tx-123', 'provider-a:tx-123',
    ]);
    expect(String(execute.mock.calls[2]?.[0])).toContain('INSERT INTO public.outbox_messages');
  });

  it('replays a legacy transaction using its pre-migration hash', async () => {
    const legacy: CreateWagerTransactionDto = {
      walletId,
      externalTransactionId: 'historic',
      idempotencyKey: 'historic',
      type: WagerTransactionType.LOSS,
      amount: '0.01',
      currency: 'BRL',
    };
    const payloadHash = createHash('sha256').update(JSON.stringify({
      walletId,
      externalTransactionId: 'historic',
      idempotencyKey: 'historic',
      type: 'LOSS',
      amount: '0.01',
      currency: 'BRL',
      referenceTransactionId: null,
    })).digest('hex');
    queue([storedWallet], [], [{
      id: 'historic-id', externalTransactionId: 'historic',
      idempotencyKey: 'historic', payloadHash, status: 'APPLIED',
    }]);
    await expect(service.submit(legacy)).resolves.toEqual({
      transactionId: 'historic-id', status: 'APPLIED', duplicate: true,
    });
  });

  it('does not hash the Idempotency-Key header into a provider payload', async () => {
    queue([storedWallet], [{ id: 'new-id', status: 'RECEIVED' }], undefined);
    await service.submitProvider(providerSubmission, 'arbitrary-key');
    const payloadHash = (execute.mock.calls[1]?.[1] as string[] | undefined)?.[12];
    const expected = createHash('sha256').update(JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: 'tx-123',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
    })).digest('hex');
    expect(payloadHash).toBe(expected);
  });

  it('keeps the historical hash and namespace for the legacy route', async () => {
    const legacy: CreateWagerTransactionDto = {
      walletId,
      externalTransactionId: 'old-bet',
      idempotencyKey: 'old-bet',
      type: WagerTransactionType.BET,
      amount: '1.00',
      currency: 'BRL',
    };
    queue([storedWallet], [{ id: 'new-id', status: 'RECEIVED' }], undefined);
    await service.submit(legacy);
    const params = execute.mock.calls[1]?.[1] as string[];
    const oldHash = createHash('sha256').update(JSON.stringify({
      walletId,
      externalTransactionId: 'old-bet',
      idempotencyKey: 'old-bet',
      type: 'BET',
      amount: '1.00',
      currency: 'BRL',
      referenceTransactionId: null,
    })).digest('hex');
    expect(params[2]).toBe('legacy');
    expect(params[12]).toBe(oldHash);
  });

  it('rejects a player that does not own the wallet', async () => {
    queue([storedWallet]);
    await expect(service.submitProvider(
      Object.assign(new SubmitWageringTransactionDto(), providerSubmission, {
        playerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
      'key',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects REFUND without a reference before persisting', async () => {
    await expect(service.submitProvider(
      Object.assign(new SubmitWageringTransactionDto(), providerSubmission, {
        kind: WagerTransactionType.REFUND,
      }),
      'key',
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a conflicting payload under the same provider key', async () => {
    queue([storedWallet], [{ id: 'old-id', status: 'RECEIVED' }], undefined);
    await service.submitProvider(providerSubmission, 'same-key');
    const originalHash = (execute.mock.calls[1]?.[1] as string[] | undefined)?.[12];
    execute.mockClear();
    queue([storedWallet], [], [{
      id: 'old-id', externalTransactionId: 'tx-123',
      idempotencyKey: 'same-key', payloadHash: originalHash, status: 'APPLIED',
    }]);
    await expect(service.submitProvider(
      Object.assign(new SubmitWageringTransactionDto(), providerSubmission, {
        money: { amount: '2.00', currency: 'BRL' },
      }),
      'same-key',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('limits conflict queries to a single provider namespace', async () => {
    queue([storedWallet], [], [{
      id: 'old-id', externalTransactionId: 'tx-123',
      idempotencyKey: 'different-key', payloadHash: 'old-hash', status: 'APPLIED',
    }]);
    await expect(service.submitProvider(providerSubmission, 'new-key'))
      .rejects.toBeInstanceOf(ConflictException);
    const sql = String(execute.mock.calls[2]?.[0]);
    expect(sql).toContain('WHERE provider_id = ?');
    expect(execute.mock.calls[2]?.[1]).toEqual(['provider-a', 'new-key', 'tx-123']);
  });

  it('enlists SQS intake in its caller transaction without re-enqueuing an internal command', async () => {
    queue([storedWallet], [{ id: 'sqs-id', status: 'RECEIVED' }]);
    const transactionManager = { execute } as unknown as EntityManager;
    const result = await service.submitProviderInTransaction(
      transactionManager,
      providerSubmission,
      'provider-a:tx-123',
    );
    expect(result).toEqual({ transactionId: 'sqs-id', status: 'RECEIVED', duplicate: false });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO public.outbox_messages'))).toBe(false);
  });

  it('preserves provider idempotency on SQS retry in the same transaction', async () => {
    const canonical = JSON.stringify({
      providerId: 'provider-a', externalTransactionId: 'tx-123', playerId,
      walletId, roundId: 'round-1', gameId: 'game-1', kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' }, referenceExternalTransactionId: null,
    });
    const payloadHash = createHash('sha256').update(canonical).digest('hex');
    queue([storedWallet], [], [{
      id: 'sqs-id', externalTransactionId: 'tx-123',
      idempotencyKey: 'provider-a:tx-123', payloadHash, status: 'APPLIED',
    }]);
    const transactionManager = { execute } as unknown as EntityManager;
    await expect(service.submitProviderInTransaction(
      transactionManager, providerSubmission, 'provider-a:tx-123',
    )).resolves.toEqual({ transactionId: 'sqs-id', status: 'APPLIED', duplicate: true });
    expect(execute).toHaveBeenCalledTimes(3);
  });

});
