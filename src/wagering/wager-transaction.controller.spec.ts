import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WagerTransactionController } from './wager-transaction.controller.js';
import { WagerTransactionIntakeService } from './wager-transaction-intake-service.js';
import { WagerTransactionType } from './entities/wager-transaction.entity.js';

const dto = {
  providerId: 'provider-a',
  externalTransactionId: 'tx-123',
  walletId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  playerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionType.BET,
  money: { amount: '1.00', currency: 'BRL' },
};

describe('WagerTransactionController provider contract', () => {
  it('requires Idempotency-Key on the new endpoint', async () => {
    const intake = { submitProvider: vi.fn() };
    const controller = new WagerTransactionController(
      intake as unknown as WagerTransactionIntakeService,
    );
    await expect(controller.submitProvider(undefined, dto))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(intake.submitProvider).not.toHaveBeenCalled();
  });

  it('maps the internal duplicate result to idempotentReplay', async () => {
    const intake = { submitProvider: vi.fn().mockResolvedValue({
      transactionId: 'same-id', status: 'APPLIED', duplicate: true,
    }) };
    const controller = new WagerTransactionController(
      intake as unknown as WagerTransactionIntakeService,
    );
    await expect(controller.submitProvider('provider-a:tx-123', dto))
      .resolves.toEqual({
        transactionId: 'same-id',
        status: 'PROCESSED',
        idempotentReplay: true,
      });
  });
});
