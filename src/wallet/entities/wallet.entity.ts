import { randomUUID } from 'node:crypto';
import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { Money } from '../../shared/domain/money.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
}

export interface OpenWalletProps {
  id?: string;
  playerId: string;
  currency: string;
  initialBalance: Money;
}

@Entity({ tableName: 'wallets' })
@Unique({
  name: 'uq_wallets_player_currency',
  properties: ['playerId', 'currency'],
})
@Check({
  name: 'chk_wallets_balance_nonnegative',
  expression: 'balance >= 0',
})
@Check({
  name: 'chk_wallets_version_positive',
  expression: 'version >= 1',
})
@Check({
  name: 'chk_wallets_currency_format',
  expression: "currency ~ '^[A-Z]{3}$'",
})
export class Wallet {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ columnType: 'varchar(3)', default: 'BRL' })
  currency = 'BRL';

  @Property({
    columnType: 'numeric(19,2)',
    default: '0.00',
  })
  balance = '0.00';

  @Property({ columnType: 'integer', default: 1 })
  version = 1;

  @Property({ onCreate: () => new Date() })
  createdAt: Date = new Date();

  static open(props: OpenWalletProps): Wallet {
    if (!props.playerId.trim()) {
      throw new TypeError('Player ID is required');
    }

    if (!/^[A-Z]{3}$/.test(props.currency)) {
      throw new TypeError('Currency must be a three-letter uppercase code');
    }

    if (props.initialBalance.currency !== props.currency) {
      throw new RangeError(
        'Initial balance currency must match wallet currency',
      );
    }

    if (props.initialBalance.isNegative()) {
      throw new RangeError('Initial balance cannot be negative');
    }

    const wallet = new Wallet();

    wallet.id = props.id ?? randomUUID();
    wallet.playerId = props.playerId;
    wallet.currency = props.currency;
    wallet.balance = props.initialBalance.toDecimalString();
    wallet.version = 1;

    return wallet;
  }

  static rehydrate(state: WalletState): Wallet {
    const wallet = new Wallet();

    wallet.id = state.id;
    wallet.playerId = state.playerId;
    wallet.currency = state.currency;
    wallet.balance = state.balance;
    wallet.version = state.version;
    wallet.createdAt = state.createdAt;

    return wallet;
  }

  getBalance(): Money {
    return Money.fromDecimal(this.balance, this.currency);
  }

  credit(amount: Money): void {
    this.assertSameCurrency(amount);
    this.assertPositiveAmount(amount);

    this.balance = this.getBalance().add(amount).toDecimalString();
    this.version += 1;
  }

  debit(amount: Money): void {
    this.assertSameCurrency(amount);
    this.assertPositiveAmount(amount);

    const newBalance = this.getBalance().subtract(amount);

    if (newBalance.isNegative()) {
      throw new Error('Insufficient funds');
    }

    this.balance = newBalance.toDecimalString();
    this.version += 1;
  }

  private assertSameCurrency(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new RangeError(
        `Currency mismatch: wallet uses ${this.currency}, amount uses ${amount.currency}`,
      );
    }
  }

  private assertPositiveAmount(amount: Money): void {
    if (amount.isNegative() || amount.isZero()) {
      throw new RangeError('Amount must be greater than zero');
    }
  }
}
