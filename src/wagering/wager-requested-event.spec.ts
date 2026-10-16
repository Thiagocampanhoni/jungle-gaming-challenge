import { describe, expect, it } from 'vitest';
import { parseWagerRequestedEvent } from './wager-requested-event.js';

const validEvent = () => ({
  messageId: 'message-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-16T09:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'external-123',
    idempotencyKey: 'provider-a:external-123',
    playerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    walletId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
  },
});

describe('WagerTransactionRequested envelope', () => {
  it('validates the external contract and returns a typed DTO', () => {
    const event = parseWagerRequestedEvent(validEvent());
    expect(event.type).toBe('WagerTransactionRequested');
    expect(event.data.money).toEqual({ amount: '1.00', currency: 'BRL' });
    expect(event.data.idempotencyKey).toBe('provider-a:external-123');
  });

  it('accepts a valid ISO timestamp with UTC offset', () => {
    const event = validEvent();
    event.occurredAt = '2026-10-16T06:00:00-03:00';
    expect(parseWagerRequestedEvent(event).occurredAt).toBe(event.occurredAt);
  });

  it('rejects messages without a stable, nonblank messageId', () => {
    expect(() => parseWagerRequestedEvent({ ...validEvent(), messageId: ' ' }))
      .toThrow('INVALID_WAGER_REQUESTED_MESSAGE_ID');
  });

  it('rejects invalid event types and timestamps', () => {
    expect(() => parseWagerRequestedEvent({ ...validEvent(), type: 'Other' }))
      .toThrow('INVALID_WAGER_REQUESTED_EVENT_TYPE');
    expect(() => parseWagerRequestedEvent({ ...validEvent(), occurredAt: 'now' }))
      .toThrow('INVALID_WAGER_REQUESTED_OCCURRED_AT');
  });

  it('rejects blank and oversized idempotency keys', () => {
    const event = validEvent();
    event.data.idempotencyKey = ' ';
    expect(() => parseWagerRequestedEvent(event))
      .toThrow('INVALID_WAGER_REQUESTED_IDEMPOTENCY_KEY');
    event.data.idempotencyKey = 'a'.repeat(129);
    expect(() => parseWagerRequestedEvent(event))
      .toThrow('INVALID_WAGER_REQUESTED_IDEMPOTENCY_KEY');
  });

  it('rejects malformed money without rounding it', () => {
    const event = validEvent();
    event.data.money.amount = '1.001';
    expect(() => parseWagerRequestedEvent(event))
      .toThrow('INVALID_WAGER_REQUESTED_BUSINESS_DATA');
  });

  it('rejects unknown properties and invalid UUIDs', () => {
    const event = validEvent();
    const withExtra = { ...event, data: { ...event.data, unauthorized: true } };
    expect(() => parseWagerRequestedEvent(withExtra))
      .toThrow('INVALID_WAGER_REQUESTED_BUSINESS_DATA');
    event.data.walletId = 'not-a-uuid';
    expect(() => parseWagerRequestedEvent(event))
      .toThrow('INVALID_WAGER_REQUESTED_BUSINESS_DATA');
  });

  it('rejects missing nested monetary data', () => {
    const event = validEvent();
    const noMoney: Record<string, unknown> = { ...event.data };
    delete noMoney.money;
    expect(() => parseWagerRequestedEvent({ ...event, data: noMoney }))
      .toThrow('INVALID_WAGER_REQUESTED_BUSINESS_DATA');
  });
});
