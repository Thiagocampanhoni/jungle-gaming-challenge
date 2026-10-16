import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export interface IntegrationEventProps<T> {
  eventId?: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId ?? randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = Object.freeze(props.data);
  }

  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export interface WagerEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  constructor(props: IntegrationEventProps<WagerEventData>) { super(props); }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerEventData & { failureCode: string }> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  constructor(props: IntegrationEventProps<WagerEventData & { failureCode: string }>) { super(props); }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); }
}

export type WagerPendingReferenceData = WagerEventData & {
  failureCode: string;
  referenceExternalTransactionId: string | null;
};

export class WagerTransactionPendingReference extends IntegrationEvent<WagerPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  constructor(props: IntegrationEventProps<WagerPendingReferenceData>) { super(props); }
}

/** Called WITHIN the same EntityManager transaction as the financial changes.
 * The deterministic deduplication key guarantees one event per wager+type+version,
 * including after retrying a PENDING_REFERENCE or an SQS command.
 */
export async function enqueueIntegrationEvent(
  tx: EntityManager,
  transactionId: string,
  event: IntegrationEvent<unknown>,
): Promise<void> {
  const deduplicationKey = createHash('sha256')
    .update(`${transactionId}:${event.eventType}:v${event.version}`)
    .digest('hex');

  await tx.execute(
    `
      INSERT INTO public.outbox_messages (
        id, wager_transaction_id, deduplication_key, event_type,
        payload, status, attempts, available_at, locked_at, last_error,
        published_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?::jsonb, 'PENDING', 0, now(), NULL, NULL, NULL, clock_timestamp(), clock_timestamp())
      ON CONFLICT (deduplication_key) DO NOTHING
    `,
    [
      event.eventId,
      transactionId,
      deduplicationKey,
      event.eventType,
      JSON.stringify(event.toJSON()),
    ],
  );
}
