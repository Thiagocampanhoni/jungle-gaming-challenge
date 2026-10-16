import { describe, expect, it } from 'vitest';
import { Money } from './money.js';

describe('Money', () => {
  it('adds decimal amounts without floating-point errors', () => {
    const result = Money.fromDecimal('0.10').add(Money.fromDecimal('0.20'));

    expect(result.toDecimalString()).toBe('0.30');
  });

  it('formats whole amounts with two decimal places', () => {
    expect(Money.fromDecimal('25').toDecimalString()).toBe('25.00');
  });

  it('supports subtraction and negative intermediate results', () => {
    const result = Money.fromDecimal('0.05').subtract(
      Money.fromDecimal('0.10'),
    );

    expect(result.toDecimalString()).toBe('-0.05');
    expect(result.isNegative()).toBe(true);
  });

  it('treats equivalent decimal strings as equal', () => {
    expect(Money.fromDecimal('10.5').equals(Money.fromDecimal('10.50'))).toBe(
      true,
    );
  });

  it.each(['', '1.234', '1e3', '1,50', 'abc', '1.'])(
    'rejects invalid decimal input: %s',
    (value) => {
      expect(() => Money.fromDecimal(value)).toThrow();
    },
  );

  it('rejects values outside the supported decimal range', () => {
    expect(() => Money.fromDecimal('100000000000000000.00')).toThrow(
      RangeError,
    );
  });

  it('preserves currency when creating and serializing money', () => {
    const money = Money.from({
      amount: '25',
      currency: 'BRL',
    });

    expect(money.currency).toBe('BRL');
    expect(money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  it('supports currencies other than BRL', () => {
    const money = Money.fromDecimal('12.50', 'USD');

    expect(money.currency).toBe('USD');
    expect(money.toDecimalString()).toBe('12.50');
    expect(money.add(Money.fromDecimal('2.50', 'USD')).toDecimalString()).toBe(
      '15.00',
    );
  });

  it('rejects arithmetic and comparisons across different currencies', () => {
    const brl = Money.fromDecimal('10.00', 'BRL');
    const usd = Money.fromDecimal('10.00', 'USD');

    expect(() => brl.add(usd)).toThrow(/Currency mismatch/);
    expect(() => brl.subtract(usd)).toThrow(/Currency mismatch/);
    expect(() => brl.equals(usd)).toThrow(/Currency mismatch/);
    expect(() => brl.isLessThan(usd)).toThrow(/Currency mismatch/);
  });

  it('negates an amount without changing its currency', () => {
    const money = Money.fromDecimal('7.25', 'USD').negate();

    expect(money.toDecimalString()).toBe('-7.25');
    expect(money.currency).toBe('USD');
    expect(money.isNegative()).toBe(true);
  });

  it('identifies positive amounts', () => {
    expect(Money.fromDecimal('0.01').isPositive()).toBe(true);
    expect(Money.zero().isPositive()).toBe(false);
    expect(Money.fromDecimal('-1.00').isPositive()).toBe(false);
  });

  it('rejects malformed currency codes', () => {
    expect(() => Money.fromDecimal('10.00', 'brl')).toThrow(TypeError);
    expect(() => Money.fromDecimal('10.00', 'US')).toThrow(TypeError);
  });

  it('creates zero in the requested currency', () => {
    const zero = Money.zero('USD');

    expect(zero.isZero()).toBe(true);
    expect(zero.currency).toBe('USD');
    expect(zero.toJSON()).toEqual({
      amount: '0.00',
      currency: 'USD',
    });
  });
});
