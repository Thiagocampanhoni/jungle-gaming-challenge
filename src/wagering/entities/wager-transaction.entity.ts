import { randomUUID } from 'node:crypto';
import {
  Check,
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { Wallet } from '../../wallet/entities/wallet.entity.js';

export enum WagerTransactionType {
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  RECEIVED = 'RECEIVED',
  PROCESSING = 'PROCESSING',
  APPLIED = 'APPLIED',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  REJECTED = 'REJECTED',
}

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'uq_wager_transactions_provider_external_id',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  name: 'uq_wager_transactions_provider_idempotency_key',
  properties: ['providerId', 'idempotencyKey'],
})
@Check({
  name: 'chk_wager_transactions_amount_positive',
  expression: 'amount > 0',
})
export class WagerTransaction {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne(() => Wallet, {
    deleteRule: 'restrict',
    updateRule: 'restrict',
  })
  wallet!: Wallet;

  @Property({ type: 'string', length: 128 })
  providerId!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', length: 128 })
  roundId!: string;

  @Property({ type: 'string', length: 128 })
  gameId!: string;

  @Property({ type: 'string', length: 128 })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 128 })
  idempotencyKey!: string;

  @Property({
    type: 'string',
    columnType: 'varchar(16)',
  })
  type!: WagerTransactionType;

  @Property({
    type: 'string',
    columnType: 'numeric(19,2)',
  })
  amount!: string;

  @Property({
    type: 'string',
    columnType: 'varchar(3)',
  })
  currency!: string;

  @Property({
    type: 'string',
    length: 128,
    nullable: true,
  })
  referenceTransactionId?: string | null;

  @Property({
    type: 'string',
    columnType: 'varchar(24)',
    default: WagerTransactionStatus.RECEIVED,
  })
  status: WagerTransactionStatus = WagerTransactionStatus.RECEIVED;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @Property({
    type: 'string',
    length: 255,
    nullable: true,
  })
  errorCode?: string | null;

  @Property({ type: Date, nullable: true })
  processedAt?: Date | null;

  @Property({ type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({
    type: Date,
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}
