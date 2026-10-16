import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'node:crypto';
import { Money, type MoneyProps } from '../shared/domain/money.js';
import { Wallet } from './entities/wallet.entity.js';
import type { CreateWalletDto } from './dto/create-wallet.dto.js';

interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
}

interface LedgerRow {
  id: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  reversesEntryId: string | null;
  cursorTimestamp: string;
}

interface ReconciliationRow {
  calculatedBalance: string;
  checkedEntries: string;
}

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerPage {
  items: {
    id: string;
    transactionId: string;
    direction: 'DEBIT' | 'CREDIT';
    money: MoneyProps;
    reversesEntryId: string | null;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

interface LedgerCursor {
  walletId: string;
  timestamp: string;
  id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** All SQL monetary values are retrieved as PostgreSQL numeric strings. */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(private readonly em: EntityManager) {}

  async create(dto: CreateWalletDto): Promise<WalletResponse> {
    let openingMoney: Money;
    try {
      openingMoney = Money.from(dto.initialBalance);
    } catch {
      throw new BadRequestException('Invalid initialBalance');
    }
    if (openingMoney.isNegative()) {
      throw new BadRequestException('Initial balance must not be negative');
    }

    const wallet = Wallet.open({
      playerId: dto.playerId.toLowerCase(),
      currency: openingMoney.currency,
      initialBalance: openingMoney,
    });

    // A wallet with an initial balance is committed together with its internal
    // OPENING transaction and immutable ledger entry. No balance version bump:
    // version 1 is the initial state immediately after wallet creation.
    return this.em.transactional(async (tx) => {
      const inserted = await tx.execute<WalletRow[]>(
        `
          INSERT INTO public.wallets (
            id, player_id, currency, balance, version, created_at
          )
          VALUES (?, ?, ?, ?, 1, now())
          ON CONFLICT (player_id, currency) DO NOTHING
          RETURNING id, player_id AS "playerId", currency, balance, version
        `,
        [wallet.id, wallet.playerId, wallet.currency, wallet.balance],
      );

      const saved = inserted[0];
      if (!saved) {
        throw new ConflictException('Wallet already exists for playerId and currency');
      }

      if (!openingMoney.isZero()) {
        const transactionId = randomUUID();
        const externalId = `wallet-opening:${wallet.id}`;
        const payloadHash = createHash('sha256')
          .update(JSON.stringify({
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: openingMoney.toJSON(),
            type: 'OPENING',
          }))
          .digest('hex');

        await tx.execute(
          `
            INSERT INTO public.wager_transactions (
              id, wallet_id, provider_id, player_id, round_id, game_id,
              external_transaction_id, idempotency_key, type, amount,
              currency, reference_transaction_id, status, payload_hash,
              error_code, processed_at, created_at, updated_at
            )
            VALUES (?, ?, 'internal', ?, 'opening', 'wallet', ?, ?, 'OPENING', ?,
                    ?, NULL, 'APPLIED', ?, NULL, now(), now(), now())
          `,
          [
            transactionId,
            wallet.id,
            wallet.playerId,
            externalId,
            externalId,
            openingMoney.toDecimalString(),
            wallet.currency,
            payloadHash,
          ],
        );

        await tx.execute(
          `
            INSERT INTO public.ledger_entries (
              id, wallet_id, wager_transaction_id, direction,
              amount, reverses_entry_id, created_at
            )
            VALUES (?, ?, ?, 'CREDIT', ?, NULL, now())
          `,
          [randomUUID(), wallet.id, transactionId, openingMoney.toDecimalString()],
        );
      }

      return this.mapWallet(saved);
    });
  }

  async findOne(walletId: string): Promise<WalletResponse> {
    return this.mapWallet(await this.findRow(walletId));
  }

  async ledger(
    walletId: string,
    limitInput?: string,
    cursorInput?: string,
  ): Promise<LedgerPage> {
    const limit = this.parseLimit(limitInput);
    const cursor = cursorInput === undefined
      ? null
      : this.decodeCursor(cursorInput, walletId);

    // A nonexistent wallet must produce 404, not an indistinguishable empty list.
    const wallet = await this.findRow(walletId);

    const cursorCondition = cursor
      ? 'AND (le.created_at, le.id) < (?::timestamptz, ?::uuid)'
      : '';
    const params: unknown[] = [walletId];
    if (cursor) {
      params.push(cursor.timestamp, cursor.id);
    }
    params.push(limit + 1);

    const rows = await this.em.execute<LedgerRow[]>(
      `
        SELECT
          le.id,
          le.wager_transaction_id AS "transactionId",
          le.direction,
          le.amount::text AS amount,
          le.reverses_entry_id AS "reversesEntryId",
          to_char(le.created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTimestamp"
        FROM public.ledger_entries AS le
        WHERE le.wallet_id = ?
          ${cursorCondition}
        ORDER BY le.created_at DESC, le.id DESC
        LIMIT ?
      `,
      params,
    );

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);

    return {
      items: pageRows.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        direction: row.direction,
        money: Money.fromDecimal(row.amount, wallet.currency).toJSON(),
        reversesEntryId: row.reversesEntryId,
        createdAt: row.cursorTimestamp,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({
          walletId,
          timestamp: last.cursorTimestamp,
          id: last.id,
        } satisfies LedgerCursor)).toString('base64url')
        : null,
    };
  }

  async reconcile(walletId: string): Promise<ReconciliationResponse> {
    const wallet = await this.findRow(walletId);
    const calculated = await this.em.execute<ReconciliationRow[]>(
      `
        SELECT
          COALESCE(SUM(CASE
            WHEN direction = 'CREDIT' THEN amount
            ELSE -amount
          END), 0)::text AS "calculatedBalance",
          COUNT(*)::text AS "checkedEntries"
        FROM public.ledger_entries
        WHERE wallet_id = ?
      `,
      [walletId],
    );

    const stored = Money.fromDecimal(wallet.balance, wallet.currency);
    const reconstructed = Money.fromDecimal(
      calculated[0]?.calculatedBalance ?? '0',
      wallet.currency,
    );
    const difference = stored.subtract(reconstructed);

    if (!difference.isZero()) {
      this.logger.warn(JSON.stringify({
        event: 'wallet_reconciliation_mismatch',
        walletId: wallet.id,
        checkedEntries: calculated[0]?.checkedEntries ?? '0',
      }));
    }

    return {
      walletId: wallet.id,
      storedBalance: stored.toJSON(),
      calculatedBalance: reconstructed.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: Number(calculated[0]?.checkedEntries ?? '0'),
    };
  }

  private async findRow(walletId: string): Promise<WalletRow> {
    const rows = await this.em.execute<WalletRow[]>(
      `
        SELECT id, player_id AS "playerId", currency,
               balance::text AS balance, version
        FROM public.wallets
        WHERE id = ?
      `,
      [walletId],
    );
    if (!rows[0]) {
      throw new NotFoundException('Wallet not found');
    }
    return rows[0];
  }

  private mapWallet(row: WalletRow): WalletResponse {
    return {
      id: row.id,
      playerId: row.playerId,
      balance: Money.fromDecimal(row.balance, row.currency).toJSON(),
      version: row.version,
    };
  }

  private parseLimit(value?: string): number {
    if (value === undefined) return 50;
    if (!/^[1-9]\d{0,2}$/.test(value)) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const parsed = Number(value);
    if (parsed < 1 || parsed > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    return parsed;
  }

  private decodeCursor(encoded: string, walletId: string): LedgerCursor {
    if (!encoded || encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new BadRequestException('Invalid ledger cursor');
    }

    try {
      const json = Buffer.from(encoded, 'base64url').toString('utf8');
      if (Buffer.from(json).toString('base64url') !== encoded) {
        throw new Error('Non-canonical cursor');
      }
      const value: unknown = JSON.parse(json);
      if (typeof value !== 'object' || value === null) {
        throw new Error('Invalid cursor shape');
      }
      const cursor = value as Record<string, unknown>;
      if (
        cursor.walletId !== walletId ||
        typeof cursor.timestamp !== 'string' ||
        !TIMESTAMP_PATTERN.test(cursor.timestamp) ||
        Number.isNaN(Date.parse(cursor.timestamp)) ||
        typeof cursor.id !== 'string' ||
        !UUID_PATTERN.test(cursor.id)
      ) {
        throw new Error('Invalid cursor contents');
      }
      return {
        walletId,
        timestamp: cursor.timestamp,
        id: cursor.id,
      };
    } catch {
      throw new BadRequestException('Invalid ledger cursor');
    }
  }
}
