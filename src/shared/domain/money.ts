const MAX_ABS_CENTS = 10n ** 19n - 1n;
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new TypeError('Currency must be a three-letter uppercase code');
    }

    if (cents > MAX_ABS_CENTS || cents < -MAX_ABS_CENTS) {
      throw new RangeError('Money exceeds the supported decimal range');
    }
  }

  static zero(currency = 'BRL'): Money {
    return new Money(0n, currency);
  }

  static fromDecimal(value: string, currency = 'BRL'): Money {
    if (typeof value !== 'string') {
      throw new TypeError('Money must be provided as a decimal string');
    }

    const match = DECIMAL_PATTERN.exec(value);

    if (!match) {
      throw new RangeError(
        'Invalid money format. Expected a decimal string with at most two decimal places',
      );
    }

    const [, sign, whole, fraction = ''] = match;
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));

    return new Money(sign === '-' ? -cents : cents, currency);
  }

  static from(props: MoneyProps): Money {
    return Money.fromDecimal(props.amount, props.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toDecimalString(),
      currency: this.currency,
    };
  }

  toDecimalString(): string {
    const absoluteCents = this.cents < 0n ? -this.cents : this.cents;
    const whole = absoluteCents / 100n;
    const fraction = (absoluteCents % 100n).toString().padStart(2, '0');
    const sign = this.cents < 0n ? '-' : '';

    return `${sign}${whole}.${fraction}`;
  }

  toString(): string {
    return this.toDecimalString();
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new RangeError(
        `Currency mismatch: ${this.currency} and ${other.currency}`,
      );
    }
  }
}
