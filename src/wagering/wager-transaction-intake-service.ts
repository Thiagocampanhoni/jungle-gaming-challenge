import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'node:crypto';
import { Money } from '../shared/domain/money.js';
import { CreateWagerTransactionDto } from './dto/create-wager-transaction.dto.js';
import { SubmitWageringTransactionDto } from './dto/submit-wagering-transaction.dto.js';
import { WagerTransactionType } from './entities/wager-transaction.entity.js';

interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
}

interface ExistingTransactionRow {
  id: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  status: string;
}

interface InsertedTransactionRow {
  id: string;
  status: string;
}

export interface WagerTransactionSubmission {
  transactionId: string;
  status: string;
  duplicate: boolean;
}

interface NormalizedSubmission {
  providerId: string;
  playerId?: string; // resolved from the wallet on legacy route
  walletId: string;
  roundId: string;
  gameId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  type: WagerTransactionType;
  amount: string;
  currency: string;
  referenceTransactionId: string | null;
}

@Injectable()
export class WagerTransactionIntakeService {
  constructor(private readonly em: EntityManager) {}

  /** Historical API retains its existing IDs and hash namespace. */
  submit(dto: CreateWagerTransactionDto): Promise<WagerTransactionSubmission> {
    return this.submitNormalized({
      providerId: 'legacy',
      walletId: dto.walletId,
      roundId: 'legacy',
      gameId: 'legacy',
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey: dto.idempotencyKey,
      type: dto.type,
      amount: dto.amount,
      currency: dto.currency,
      referenceTransactionId: dto.referenceTransactionId ?? null,
    });
  }

  submitProvider(
    dto: SubmitWageringTransactionDto,
    idempotencyKey: string,
  ): Promise<WagerTransactionSubmission> {
    return this.submitNormalized(this.normalizeProvider(dto, idempotencyKey));
  }

  /** Reuses HTTP submission rules inside an SQS-owned SQL transaction.
   * The external SQS command must not publish a second internal receive command.
   */
  submitProviderInTransaction(
    tx: EntityManager,
    dto: SubmitWageringTransactionDto,
    idempotencyKey: string,
  ): Promise<WagerTransactionSubmission> {
    return this.submitNormalized(
      this.normalizeProvider(dto, idempotencyKey),
      tx,
      false,
    );
  }

  private normalizeProvider(
    dto: SubmitWageringTransactionDto,
    idempotencyKey: string,
  ): NormalizedSubmission {
    if (['legacy', 'internal'].includes(dto.providerId)) {
      throw new BadRequestException('This providerId is reserved');
    }

    if (
      !idempotencyKey ||
      idempotencyKey.trim() !== idempotencyKey ||
      idempotencyKey.length > 128
    ) {
      throw new BadRequestException('Valid Idempotency-Key is required');
    }

    return {
      providerId: dto.providerId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      type: dto.kind,
      amount: dto.money.amount,
      currency: dto.money.currency,
      referenceTransactionId: dto.referenceExternalTransactionId ?? null,
    };
  }

  private async submitNormalized(
    dto: NormalizedSubmission,
    transactionManager?: EntityManager,
    emitReceiveCommand = true,
  ): Promise<WagerTransactionSubmission> {
    if (
      (dto.type === WagerTransactionType.REFUND ||
        dto.type === WagerTransactionType.ROLLBACK) &&
      !dto.referenceTransactionId
    ) {
      throw new BadRequestException(
        'Reference transaction is required for REFUND and ROLLBACK',
      );
    }

    const walletId = dto.walletId.toLowerCase();
    const money = Money.fromDecimal(dto.amount, dto.currency);
    if (!money.isPositive()) {
      throw new BadRequestException('Amount must be positive');
    }
    const amount = money.toDecimalString();
    const currency = money.currency;

    const submit = async (
      tx: EntityManager,
    ): Promise<WagerTransactionSubmission> => {
      const wallets = await tx.execute<WalletRow[]>(
        `
          SELECT id, player_id AS "playerId", currency
          FROM public.wallets
          WHERE id = ?
        `,
        [walletId],
      );
      const wallet = wallets[0];

      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }
      if (wallet.currency !== currency) {
        throw new ConflictException(
          'Transaction currency does not match wallet currency',
        );
      }

      const playerId = (dto.playerId ?? wallet.playerId).toLowerCase();
      if (wallet.playerId.toLowerCase() !== playerId) {
        throw new ConflictException('Wallet does not belong to playerId');
      }

      // Preserve the existing hash on historical 'legacy' transactions so
      // a request created before this migration still replays successfully.
      // The new provider contract excludes the Idempotency-Key transport header
      // and uses a deterministic, fixed-order business-field projection.
      const canonicalPayload = dto.providerId === 'legacy'
        ? JSON.stringify({
            walletId,
            externalTransactionId: dto.externalTransactionId,
            idempotencyKey: dto.idempotencyKey,
            type: dto.type,
            amount,
            currency,
            referenceTransactionId: dto.referenceTransactionId,
          })
        : JSON.stringify({
            providerId: dto.providerId,
            externalTransactionId: dto.externalTransactionId,
            playerId,
            walletId,
            roundId: dto.roundId,
            gameId: dto.gameId,
            kind: dto.type,
            money: { amount, currency },
            referenceExternalTransactionId: dto.referenceTransactionId,
          });
      const payloadHash = createHash('sha256')
        .update(canonicalPayload)
        .digest('hex');

      const transactionId = randomUUID();
      const inserted = await tx.execute<InsertedTransactionRow[]>(
        `
          INSERT INTO public.wager_transactions (
            id,
            wallet_id,
            provider_id,
            player_id,
            round_id,
            game_id,
            external_transaction_id,
            idempotency_key,
            type,
            amount,
            currency,
            reference_transaction_id,
            status,
            payload_hash,
            error_code,
            processed_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, NULL, NULL, now(), now())
          ON CONFLICT DO NOTHING
          RETURNING id, status
        `,
        [
          transactionId,
          walletId,
          dto.providerId,
          playerId,
          dto.roundId,
          dto.gameId,
          dto.externalTransactionId,
          dto.idempotencyKey,
          dto.type,
          amount,
          currency,
          dto.referenceTransactionId,
          payloadHash,
        ],
      );

      const created = inserted[0];
      if (!created) {
        const existingRows = await tx.execute<ExistingTransactionRow[]>(
          `
            SELECT
              id,
              external_transaction_id AS "externalTransactionId",
              idempotency_key AS "idempotencyKey",
              payload_hash AS "payloadHash",
              status
            FROM public.wager_transactions
            WHERE provider_id = ?
              AND (idempotency_key = ? OR external_transaction_id = ?)
            FOR UPDATE
          `,
          [dto.providerId, dto.idempotencyKey, dto.externalTransactionId],
        );

        if (existingRows.length !== 1) {
          throw new ConflictException(
            'Transaction identifier conflicts with an existing transaction',
          );
        }
        const existing = existingRows[0];
        if (
          existing.idempotencyKey !== dto.idempotencyKey ||
          existing.externalTransactionId !== dto.externalTransactionId ||
          existing.payloadHash !== payloadHash
        ) {
          throw new ConflictException(
            'The idempotency key or external transaction ID was already used with a different payload',
          );
        }
        return {
          transactionId: existing.id,
          status: existing.status,
          duplicate: true,
        };
      }

      if (emitReceiveCommand) {
        const outboxId = randomUUID();
        const deduplicationKey = createHash('sha256')
          .update(`wager-transaction-received:${created.id}`)
          .digest('hex');

        await tx.execute(
          `
            INSERT INTO public.outbox_messages (
              id, wager_transaction_id, deduplication_key, event_type,
              payload, status, attempts, available_at, locked_at, last_error,
              published_at, created_at, updated_at
            )
            VALUES (?, ?, ?, 'WAGER_TRANSACTION_RECEIVED', ?::jsonb, 'PENDING', 0, now(), NULL, NULL, NULL, now(), now())
          `,
          [
            outboxId,
            created.id,
            deduplicationKey,
            JSON.stringify({ transactionId: created.id }),
          ],
        );
      }

      return {
        transactionId: created.id,
        status: 'RECEIVED',
        duplicate: false,
      };
    };

    return transactionManager
      ? submit(transactionManager)
      : this.em.transactional(submit);
  }
}
