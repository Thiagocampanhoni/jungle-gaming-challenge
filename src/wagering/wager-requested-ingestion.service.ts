import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionIntakeService } from './wager-transaction-intake-service.js';
import { WagerTransactionProcessor } from './wager-transaction.processor.service.js';
import type { WagerTransactionRequestedEvent } from './wager-requested-event.js';

@Injectable()
export class WagerRequestedIngestionService {
  constructor(
    private readonly em: EntityManager,
    private readonly intake: WagerTransactionIntakeService,
    private readonly processor: WagerTransactionProcessor,
  ) {}

  /** One SQL commit for ingestion, inbox receipt, wager state and ledger. */
  async receive(event: WagerTransactionRequestedEvent, rawBody: string) {
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');

    return this.em.transactional(async (tx) => {
      const submission = await this.intake.submitProviderInTransaction(
        tx,
        event.data,
        event.data.idempotencyKey,
      );

      const result = await this.processor.processWithTransaction(
        tx,
        submission.transactionId,
        {
          consumerName: 'wager-transaction-consumer',
          messageId: event.messageId,
          payloadHash,
        },
      );

      return {
        ...result,
        transactionId: submission.transactionId,
        duplicate: submission.duplicate,
      };
    });
  }
}
