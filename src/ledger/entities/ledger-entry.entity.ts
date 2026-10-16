import { randomUUID } from 'node:crypto';
import {
  Check,
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { Wallet } from '../../wallet/entities/wallet.entity.js';
import { WagerTransaction } from '../../wagering/entities/wager-transaction.entity.js';

export enum LedgerEntryDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

@Entity({ tableName: 'ledger_entries' })
@Check({
  name: 'chk_ledger_entries_amount_positive',
  expression: 'amount > 0',
})
@Check({
  name: 'chk_ledger_entries_direction',
  expression: `"direction" in ('DEBIT', 'CREDIT')`,
})
export class LedgerEntry {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne(() => Wallet, {
    deleteRule: 'restrict',
    updateRule: 'restrict',
  })
  wallet!: Wallet;

  @ManyToOne(() => WagerTransaction, {
    fieldName: 'wager_transaction_id',
    unique: 'uq_ledger_entries_wager_transaction',
    deleteRule: 'restrict',
    updateRule: 'restrict',
  })
  transaction!: WagerTransaction;

  @Property({
    type: 'string',
    columnType: 'varchar(6)',
  })
  direction!: LedgerEntryDirection;

  @Property({
    type: 'string',
    columnType: 'numeric(19,2)',
  })
  amount!: string;

  @ManyToOne(() => LedgerEntry, {
    fieldName: 'reverses_entry_id',
    nullable: true,
    unique: 'uq_ledger_entries_reverses_entry',
    deleteRule: 'restrict',
    updateRule: 'restrict',
  })
  reversesEntry?: LedgerEntry | null;

  @Property({ type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date();
}
