import { describe, expect, it, vi } from 'vitest';
import { WagerTransactionQueryController } from './wager-transaction-query.controller.js';
import { WagerTransactionQueryService } from './wager-transaction-query.service.js';

describe('WagerTransactionQueryController', () => {
  it('delegates the UUID lookup', async () => {
    const findById = vi.fn().mockResolvedValue({ status: 'PROCESSED' });
    const controller = new WagerTransactionQueryController(
      { findById } as unknown as WagerTransactionQueryService,
    );
    await expect(controller.findById('tx-1')).resolves.toEqual({ status: 'PROCESSED' });
    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith('tx-1');
  });

  it('delegates the provider-scoped lookup without changing the supplied identifiers', async () => {
    const findByProviderExternalId = vi.fn().mockResolvedValue({ status: 'REJECTED' });
    const controller = new WagerTransactionQueryController(
      { findByProviderExternalId } as unknown as WagerTransactionQueryService,
    );
    await expect(
      controller.findByProviderExternalId('provider-a', 'bet-123'),
    ).resolves.toEqual({ status: 'REJECTED' });
    expect(findByProviderExternalId).toHaveBeenCalledTimes(1);
    expect(findByProviderExternalId).toHaveBeenCalledWith('provider-a', 'bet-123');
  });
});
