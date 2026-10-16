import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/domain/money.js';
import { Wallet } from './wallet.entity.js';

const createWallet = (initialBalance = '0.00') =>
  Wallet.open({
    playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    currency: 'BRL',
    initialBalance: Money.fromDecimal(initialBalance),
  });

describe('Wallet', () => {
  it('opens with zero balance and version 1', () => {
    const wallet = createWallet();

    expect(wallet.getBalance().toDecimalString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
  });

  it('credits money without floating-point errors', () => {
    const wallet = createWallet();

    wallet.credit(Money.fromDecimal('0.10'));
    wallet.credit(Money.fromDecimal('0.20'));

    expect(wallet.balance).toBe('0.30');
    expect(wallet.version).toBe(3);
  });

  it('debits money when sufficient funds are available', () => {
    const wallet = createWallet('20.00');

    wallet.debit(Money.fromDecimal('7.25'));

    expect(wallet.balance).toBe('12.75');
    expect(wallet.version).toBe(2);
  });

  it('does not change balance or version after an insufficient debit', () => {
    const wallet = createWallet('5.00');

    expect(() => {
      wallet.debit(Money.fromDecimal('5.01'));
    }).toThrow('Insufficient funds');

    expect(wallet.balance).toBe('5.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects zero and negative amounts', () => {
    const wallet = createWallet();

    expect(() => wallet.credit(Money.zero())).toThrow(RangeError);
    expect(() => wallet.debit(Money.fromDecimal('-1.00'))).toThrow(RangeError);

    expect(wallet.balance).toBe('0.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects an invalid currency code', () => {
    expect(() =>
      Wallet.open({
        playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        currency: 'brl',
        initialBalance: Money.zero(),
      }),
    ).toThrow('Currency must be a three-letter uppercase code');
  });

  it('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        currency: 'BRL',
        initialBalance: Money.fromDecimal('-1.00'),
      }),
    ).toThrow('Initial balance cannot be negative');
  });
});
