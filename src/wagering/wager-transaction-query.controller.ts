import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  WagerTransactionQueryService,
  type WagerTransactionDetails,
} from './wager-transaction-query.service.js';

/** Read-only routes, separated from the ingestion controller to avoid changing POST behavior. */
@Controller()
export class WagerTransactionQueryController {
  constructor(private readonly queries: WagerTransactionQueryService) {}

  @Get('wagering/transactions/:transactionId')
  findById(
    @Param('transactionId', new ParseUUIDPipe()) transactionId: string,
  ): Promise<WagerTransactionDetails> {
    return this.queries.findById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  findByProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionDetails> {
    return this.queries.findByProviderExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
