import { randomUUID } from 'node:crypto';
import {
  Check,
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { WagerTransaction } from '../../wagering/entities/wager-transaction.entity.js';

export enum OutboxMessageStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PUBLISHED = 'PUBLISHED',
  DEAD = 'DEAD',
}

export enum OutboxEventType {
  WAGER_TRANSACTION_RECEIVED = 'WAGER_TRANSACTION_RECEIVED',
  WAGER_TRANSACTION_PROCESSED = 'WagerTransactionProcessed',
  WAGER_TRANSACTION_REJECTED = 'WagerTransactionRejected',
  WALLET_BALANCE_CHANGED = 'WalletBalanceChanged',
  WAGER_TRANSACTION_PENDING_REFERENCE = 'WagerTransactionPendingReference',
}

@Entity({ tableName: 'outbox_messages' })
@Unique({
  name: 'uq_outbox_messages_deduplication_key',
  properties: ['deduplicationKey'],
})
@Check({
  name: 'chk_outbox_messages_attempts_nonnegative',
  expression: '"attempts" >= 0',
})
export class OutboxMessage {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne(() => WagerTransaction, {
    fieldName: 'wager_transaction_id',
    deleteRule: 'restrict',
    updateRule: 'restrict',
  })
  transaction!: WagerTransaction;

  @Property({ type: 'string', length: 64 })
  deduplicationKey!: string;

  @Property({ type: 'string', length: 64 })
  eventType!: OutboxEventType;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({
    type: 'string',
    columnType: 'varchar(16)',
    default: OutboxMessageStatus.PENDING,
  })
  status: OutboxMessageStatus = OutboxMessageStatus.PENDING;

  @Property({ type: 'number', columnType: 'integer', default: 0 })
  attempts = 0;

  @Property({ type: Date, onCreate: () => new Date() })
  availableAt: Date = new Date();

  @Property({ type: Date, nullable: true })
  lockedAt?: Date | null;

  @Property({ type: 'string', length: 1000, nullable: true })
  lastError?: string | null;

  @Property({ type: Date, nullable: true })
  publishedAt?: Date | null;

  @Property({ type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({
    type: Date,
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}
