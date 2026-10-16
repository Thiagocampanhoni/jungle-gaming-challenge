import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

interface WagerTransactionQueryRow {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  status: string;
  errorCode: string | null;
  createdAt: Date | string;
  processedAt: Date | string | null;
}

/** Public transaction view. Deliberately omits internal idempotency keys and payload hashes. */
export interface WagerTransactionDetails {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId: string | null;
  status: string;
  failureCode: string | null;
  createdAt: string;
  processedAt: string | null;
}

@Injectable()
export class WagerTransactionQueryService {
  constructor(private readonly em: EntityManager) {}

  async findById(transactionId: string): Promise<WagerTransactionDetails> {
    const rows = await this.em.execute<WagerTransactionQueryRow[]>(
      `${this.baseQuery} WHERE wt.id = ?::uuid LIMIT 1`,
      [transactionId],
    );
    return this.requireAndMap(rows);
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionDetails> {
    this.validateIdentifier(providerId, 'providerId');
    this.validateIdentifier(externalTransactionId, 'externalTransactionId');

    const rows = await this.em.execute<WagerTransactionQueryRow[]>(
      `${this.baseQuery} WHERE wt.provider_id = ? AND wt.external_transaction_id = ? LIMIT 1`,
      [providerId, externalTransactionId],
    );
    return this.requireAndMap(rows);
  }

  private get baseQuery(): string {
    return `
      SELECT
        wt.id AS "transactionId",
        wt.provider_id AS "providerId",
        wt.external_transaction_id AS "externalTransactionId",
        wt.player_id AS "playerId",
        wt.wallet_id AS "walletId",
        wt.round_id AS "roundId",
        wt.game_id AS "gameId",
        wt.type AS kind,
        wt.amount::text AS amount,
        wt.currency,
        wt.reference_transaction_id AS "referenceExternalTransactionId",
        wt.status,
        wt.error_code AS "errorCode",
        wt.created_at AS "createdAt",
        wt.processed_at AS "processedAt"
      FROM public.wager_transactions wt
    `;
  }

  private validateIdentifier(value: string, field: string): void {
    // Keep the same 1..128 length and non-whitespace requirement as the POST DTO.
    if (!value || value.length > 128 || !/\S/.test(value)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
  }

  private requireAndMap(rows: WagerTransactionQueryRow[]): WagerTransactionDetails {
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Wager transaction not found');
    }

    return {
      transactionId: row.transactionId,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      playerId: row.playerId,
      walletId: row.walletId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind,
      money: { amount: row.amount, currency: row.currency },
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      status: row.status === 'APPLIED' ? 'PROCESSED' : row.status,
      failureCode: row.errorCode,
      createdAt: new Date(row.createdAt).toISOString(),
      processedAt: row.processedAt ? new Date(row.processedAt).toISOString() : null,
    };
  }
}
