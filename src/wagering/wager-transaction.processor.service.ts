import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../shared/domain/money.js';
import { randomUUID } from 'node:crypto';
import {
  enqueueIntegrationEvent,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  type WagerEventData,
} from '../outbox/events/integration-events.js';

interface WagerRow {
  id: string;
  walletId: string;
  externalTransactionId: string;
  providerId: string;
  playerId: string;
  roundId: string;
  type: string;
  amount: string;
  referenceTransactionId: string | null;
  status: string;
  currency: string;
}

interface WalletRow {
  id: string;
  balance: string;
  currency: string;
  version: number;
}

interface OriginalTransactionRow {
  id: string;
  walletId: string;
  providerId: string;
  playerId: string;
  roundId: string;
  type: string;
  status: string;
  ledgerEntryId: string | null;
  ledgerDirection: 'DEBIT' | 'CREDIT' | null;
  ledgerAmount: string | null;
  currency: string;
}

export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

interface ExistingInboxRow {
  transactionId: string;
  payloadHash: string;
  processedAt: Date | null;
}

type ProcessingResult =
  | {
      disposition: 'ACK';
      status: 'APPLIED' | 'REJECTED' | 'ALREADY_APPLIED';
    }
  | {
      disposition: 'RETRY';
      status: 'PENDING_REFERENCE' | 'NOT_FOUND';
      reason: string;
    };

@Injectable()
export class WagerTransactionProcessor {
  constructor(private readonly em: EntityManager) {}

  async process(transactionId: string, receipt?: InboxReceipt): Promise<ProcessingResult> {
    return this.em.transactional((tx) =>
      this.processWithTransaction(tx, transactionId, receipt),
    );
  }

  /** External SQS commands enlist inbox, intake, wallet and ledger in one commit. */
  async processWithTransaction(
    tx: EntityManager,
    transactionId: string,
    receipt?: InboxReceipt,
  ): Promise<ProcessingResult> {
      if (receipt) {
        const inserted = await tx.execute<{ messageId: string }[]>(
          `
            INSERT INTO public.inbox_messages (
              consumer_name, message_id, transaction_id, payload_hash,
              received_at, processed_at
            )
            VALUES (?, ?, ?, ?, now(), NULL)
            ON CONFLICT (consumer_name, message_id) DO NOTHING
            RETURNING message_id AS "messageId"
          `,
          [receipt.consumerName, receipt.messageId, transactionId, receipt.payloadHash],
        );

        if (inserted.length === 0) {
          // ON CONFLICT waits for an in-flight insert to commit or roll back.
          // FOR UPDATE serializes retries of an unprocessed receipt.
          const existing = await tx.execute<ExistingInboxRow[]>(
            `
              SELECT transaction_id AS "transactionId",
                     payload_hash AS "payloadHash",
                     processed_at AS "processedAt"
              FROM public.inbox_messages
              WHERE consumer_name = ? AND message_id = ?
              FOR UPDATE
            `,
            [receipt.consumerName, receipt.messageId],
          );
          const previous = existing[0];
          if (!previous || previous.transactionId !== transactionId ||
              previous.payloadHash !== receipt.payloadHash) {
            throw new Error('INBOX_MESSAGE_CONFLICT');
          }
          if (previous.processedAt !== null) {
            return { disposition: 'ACK', status: 'ALREADY_APPLIED' };
          }
        }
      }

      const result = await this.processInTransaction(tx, transactionId);

      if (receipt && result.disposition === 'ACK') {
        // Must commit together with wallet, ledger and transaction state.
        await tx.execute(
          `
            UPDATE public.inbox_messages
            SET processed_at = now()
            WHERE consumer_name = ? AND message_id = ?
              AND processed_at IS NULL
          `,
          [receipt.consumerName, receipt.messageId],
        );
      }

      // On RETRY the receipt remains persisted but unprocessed, so redelivery
      // can safely continue instead of falsely acknowledging the message.
      return result;
  }

  private async processInTransaction(
    tx: EntityManager,
    transactionId: string,
  ): Promise<ProcessingResult> {
      const transactions = await tx.execute<WagerRow[]>(
        `
          SELECT
            id,
            wallet_id AS "walletId",
            external_transaction_id AS "externalTransactionId",
            provider_id AS "providerId",
            player_id AS "playerId",
            round_id AS "roundId",
            type,
            amount,
            currency,
            reference_transaction_id AS "referenceTransactionId",
            status
          FROM public.wager_transactions
          WHERE id = ?
          FOR UPDATE
        `,
        [transactionId],
      );

      const wager = transactions[0];

      if (!wager) {
        return {
          disposition: 'RETRY',
          status: 'NOT_FOUND',
          reason: 'TRANSACTION_NOT_FOUND',
        };
      }

      if (wager.status === 'APPLIED') {
        return { disposition: 'ACK', status: 'ALREADY_APPLIED' };
      }

      if (wager.status === 'REJECTED') {
        return { disposition: 'ACK', status: 'REJECTED' };
      }

      if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(wager.type)) {
        return this.reject(tx, wager, 'INVALID_TRANSACTION_TYPE');
      }

      const amount = Money.fromDecimal(wager.amount, wager.currency);

      if (amount.isNegative() || amount.isZero()) {
        return this.reject(tx, wager, 'INVALID_AMOUNT');
      }

      let original: OriginalTransactionRow | undefined;

      if (wager.type === 'REFUND' || wager.type === 'ROLLBACK') {
        if (!wager.referenceTransactionId) {
          return this.markPendingReference(tx, wager, 'REFERENCE_REQUIRED');
        }

        const references = await tx.execute<OriginalTransactionRow[]>(
          `
            SELECT
              wt.id,
              wt.wallet_id AS "walletId",
              wt.provider_id AS "providerId",
              wt.player_id AS "playerId",
              wt.round_id AS "roundId",
              wt.type,
              wt.status,
              wt.currency AS "currency",
              le.id AS "ledgerEntryId",
              le.direction AS "ledgerDirection",
              le.amount AS "ledgerAmount"
            FROM public.wager_transactions wt
            LEFT JOIN public.ledger_entries le
              ON le.wager_transaction_id = wt.id
            WHERE wt.provider_id = ? AND wt.external_transaction_id = ?
            FOR UPDATE OF wt
          `,
          [wager.providerId, wager.referenceTransactionId],
        );

        original = references[0];

        if (!original) {
          return this.markPendingReference(tx, wager, 'REFERENCE_NOT_FOUND');
        }

        if (original.status === 'REJECTED') {
          return this.reject(tx, wager, 'REFERENCE_REJECTED');
        }

        if (original.status !== 'APPLIED') {
          return this.markPendingReference(
            tx,
            wager,
            'REFERENCE_NOT_PROCESSED',
          );
        }

        // REFUND only compensates an applied BET. ROLLBACK may reverse
        // a BET, a WIN, or a previously applied REFUND.
        const allowedReferenceTypes =
          wager.type === 'REFUND'
            ? ['BET']
            : ['BET', 'WIN', 'REFUND'];

        if (!allowedReferenceTypes.includes(original.type)) {
          return this.reject(tx, wager, 'REFERENCE_TYPE_NOT_ALLOWED');
        }

        if (
          !original.ledgerEntryId ||
          !original.ledgerDirection ||
          !original.ledgerAmount
        ) {
          return this.reject(tx, wager, 'REFERENCE_NOT_REVERSIBLE');
        }

        if (original.providerId !== wager.providerId) {
          return this.reject(tx, wager, 'REFERENCE_PROVIDER_MISMATCH');
        }

        if (original.playerId !== wager.playerId) {
          return this.reject(tx, wager, 'REFERENCE_PLAYER_MISMATCH');
        }

        if (original.roundId !== wager.roundId) {
          return this.reject(tx, wager, 'REFERENCE_ROUND_MISMATCH');
        }

        if (original.walletId !== wager.walletId) {
          return this.reject(tx, wager, 'REFERENCE_WALLET_MISMATCH');
        }

        if (original.currency !== wager.currency) {
          return this.reject(tx, wager, 'REFERENCE_CURRENCY_MISMATCH');
        }

        if (
          !amount.equals(
            Money.fromDecimal(original.ledgerAmount, original.currency),
          )
        ) {
          return this.reject(tx, wager, 'REVERSAL_AMOUNT_MISMATCH');
        }
        const existingReversals = await tx.execute<{ id: string }[]>(
          `
            SELECT id
            FROM public.ledger_entries
            WHERE reverses_entry_id = ?
            LIMIT 1
          `,
          [original.ledgerEntryId],
        );

        if (existingReversals.length > 0) {
          return this.reject(tx, wager, 'REFERENCE_ALREADY_REVERSED');
        }
      }

      const wallets = await tx.execute<WalletRow[]>(
        `
          SELECT id, balance, currency, version
          FROM public.wallets
          WHERE id = ?
          FOR UPDATE
        `,
        [wager.walletId],
      );

      const wallet = wallets[0];

      if (!wallet) {
        return this.reject(tx, wager, 'WALLET_NOT_FOUND');
      }

      if (wallet.currency !== wager.currency) {
        return this.reject(tx, wager, 'CURRENCY_MISMATCH');
      }

      const currentBalance = Money.fromDecimal(wallet.balance, wallet.currency);
      let nextBalance = currentBalance;
      let direction: 'DEBIT' | 'CREDIT' | undefined;
      let reversesEntryId: string | null = null;

      switch (wager.type) {
        case 'BET':
          nextBalance = currentBalance.subtract(amount);
          direction = 'DEBIT';
          break;

        case 'WIN':
          nextBalance = currentBalance.add(amount);
          direction = 'CREDIT';
          break;

        case 'LOSS':
          // LOSS registra o resultado da aposta sem alterar o saldo.
          break;

        case 'REFUND':
        case 'ROLLBACK':
          if (!original?.ledgerEntryId || !original.ledgerDirection) {
            return this.reject(tx, wager, 'REFERENCE_NOT_REVERSIBLE');
          }

          reversesEntryId = original.ledgerEntryId;
          direction = original.ledgerDirection === 'DEBIT' ? 'CREDIT' : 'DEBIT';

          nextBalance =
            direction === 'CREDIT'
              ? currentBalance.add(amount)
              : currentBalance.subtract(amount);
          break;
      }

      if (nextBalance.isNegative()) {
        const failureCode =
          wager.type === 'ROLLBACK' || wager.type === 'REFUND'
            ? 'REVERSAL_INSUFFICIENT_FUNDS'
            : 'INSUFFICIENT_FUNDS';

        return this.reject(tx, wager, failureCode);
      }

      if (direction) {
        await tx.execute(
          `
            UPDATE public.wallets
            SET balance = ?,
                version = version + 1
            WHERE id = ?
          `,
          [nextBalance.toDecimalString(), wallet.id],
        );

        const entryId = randomUUID();

        await tx.execute(
          `
            INSERT INTO public.ledger_entries (
              id,
              wallet_id,
              wager_transaction_id,
              direction,
              amount,
              reverses_entry_id,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, now())
          `,
          [
            entryId,
            wallet.id,
            wager.id,
            direction,
            amount.toDecimalString(),
            reversesEntryId,
          ],
        );
      }

      await tx.execute(
        `
          UPDATE public.wager_transactions
          SET status = 'APPLIED',
              error_code = NULL,
              processed_at = now(),
              updated_at = now()
          WHERE id = ?
        `,
        [wager.id],
      );

      const context = this.eventContext(wager);
      await enqueueIntegrationEvent(tx, wager.id, new WagerTransactionProcessed(context));

      if (direction) {
        await enqueueIntegrationEvent(
          tx,
          wager.id,
          new WalletBalanceChanged({
            ...context,
            data: {
              walletId: wallet.id,
              transactionId: wager.id,
              direction,
              money: { amount: amount.toDecimalString(), currency: wager.currency },
              balanceBefore: { amount: currentBalance.toDecimalString(), currency: wager.currency },
              balanceAfter: { amount: nextBalance.toDecimalString(), currency: wager.currency },
              walletVersion: Number(wallet.version) + 1,
            },
          }),
        );
      }

      return { disposition: 'ACK', status: 'APPLIED' };
  }

  private eventContext(wager: WagerRow) {
    const data: WagerEventData = {
      transactionId: wager.id,
      providerId: wager.providerId,
      externalTransactionId: wager.externalTransactionId,
      playerId: wager.playerId,
      walletId: wager.walletId,
      roundId: wager.roundId,
      kind: wager.type,
      money: { amount: wager.amount, currency: wager.currency },
    };
    return {
      aggregateId: wager.walletId,
      correlationId: wager.id,
      causationId: wager.externalTransactionId,
      data,
    };
  }

  private async reject(
    tx: EntityManager,
    wager: WagerRow,
    errorCode: string,
  ): Promise<ProcessingResult> {
    await tx.execute(
      `
        UPDATE public.wager_transactions
        SET status = 'REJECTED',
            error_code = ?,
            processed_at = now(),
            updated_at = now()
        WHERE id = ?
      `,
      [errorCode, wager.id],
    );
    const context = this.eventContext(wager);
    await enqueueIntegrationEvent(
      tx,
      wager.id,
      new WagerTransactionRejected({
        ...context,
        data: { ...context.data, failureCode: errorCode },
      }),
    );
    return { disposition: 'ACK', status: 'REJECTED' };
  }

  /** Worker-only terminal transition: under the caller's SQL transaction.
   * The same transaction persists the rejection event and Inbox ACK state.
   */
  async rejectPendingReferenceInTransaction(
    tx: EntityManager,
    transactionId: string,
    reason: 'REFERENCE_EXPIRED' | 'REFERENCE_RETRY_EXHAUSTED',
  ): Promise<'REJECTED' | 'ALREADY_TERMINAL'> {
    const rows = await tx.execute<WagerRow[]>(
      `
        SELECT id, wallet_id AS "walletId",
               external_transaction_id AS "externalTransactionId",
               provider_id AS "providerId", player_id AS "playerId",
               round_id AS "roundId", type, amount, currency,
               reference_transaction_id AS "referenceTransactionId", status
        FROM public.wager_transactions
        WHERE id = ?
        FOR UPDATE
      `,
      [transactionId],
    );
    const wager = rows[0];
    if (!wager) {
      throw new Error('PENDING_REFERENCE_TRANSACTION_NOT_FOUND');
    }
    if (wager.status !== 'PENDING_REFERENCE') {
      return 'ALREADY_TERMINAL';
    }
    await this.reject(tx, wager, reason);
    return 'REJECTED';
  }

  private async markPendingReference(
    tx: EntityManager,
    wager: WagerRow,
    errorCode: string,
  ): Promise<ProcessingResult> {
    await tx.execute(
      `
        UPDATE public.wager_transactions
        SET status = 'PENDING_REFERENCE',
            error_code = ?,
            updated_at = now()
        WHERE id = ?
      `,
      [errorCode, wager.id],
    );
    // Durable recovery is enrolled in the same transaction as the status,
    // pending-reference event, and the unprocessed Inbox receipt. Existing
    // jobs keep their original expiry and retry counters on SQS redelivery.
    await tx.execute(
      `
        INSERT INTO public.pending_reference_jobs (
          transaction_id, status, attempts, next_attempt_at,
          expires_at, created_at, updated_at
        )
        VALUES (?, 'PENDING', 0, now() + interval '10 seconds',
                now() + interval '24 hours', now(), now())
        ON CONFLICT (transaction_id) DO NOTHING
      `,
      [wager.id],
    );

    const context = this.eventContext(wager);
    await enqueueIntegrationEvent(
      tx,
      wager.id,
      new WagerTransactionPendingReference({
        ...context,
        data: {
          ...context.data,
          failureCode: errorCode,
          referenceExternalTransactionId: wager.referenceTransactionId,
        },
      }),
    );
    return {
      disposition: 'RETRY',
      status: 'PENDING_REFERENCE',
      reason: errorCode,
    };
  }
}
