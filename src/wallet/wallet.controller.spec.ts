import { describe, expect, it, vi } from 'vitest';
import { WalletController } from './wallet.controller.js';
import { WalletService } from './wallet.service.js';

const walletId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mockService = () => ({
  create: vi.fn(),
  findOne: vi.fn(),
  ledger: vi.fn(),
  reconcile: vi.fn(),
});

describe('WalletController', () => {
  it('delegates creation to the service', async () => {
    const stub = mockService();
    stub.create.mockResolvedValue({ id: walletId });
    const controller = new WalletController(stub as unknown as WalletService);
    const dto = { playerId: walletId, initialBalance: { amount: '0.00', currency: 'BRL' } };
    await expect(controller.create(dto)).resolves.toEqual({ id: walletId });
    expect(stub.create).toHaveBeenCalledWith(dto);
  });

  it('delegates ledger pagination using unchanged cursor parameters', async () => {
    const stub = mockService();
    stub.ledger.mockResolvedValue({ items: [], nextCursor: null });
    const controller = new WalletController(stub as unknown as WalletService);
    await controller.ledger(walletId, '25', 'cursor-value');
    expect(stub.ledger).toHaveBeenCalledWith(walletId, '25', 'cursor-value');
  });
});
