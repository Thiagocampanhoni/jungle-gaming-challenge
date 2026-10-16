import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SubmitWageringTransactionDto } from './dto/submit-wagering-transaction.dto.js';

export interface WagerTransactionRequestedEvent {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: SubmitWageringTransactionDto & { idempotencyKey: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseWagerRequestedEvent(value: unknown): WagerTransactionRequestedEvent {
  if (!isRecord(value) || value.type !== 'WagerTransactionRequested') {
    throw new Error('INVALID_WAGER_REQUESTED_EVENT_TYPE');
  }

  if (Object.keys(value).some((key) =>
    !['messageId', 'type', 'occurredAt', 'data'].includes(key))) {
    throw new Error('INVALID_WAGER_REQUESTED_ENVELOPE_FIELDS');
  }

  const { messageId, occurredAt, data } = value;
  if (
    typeof messageId !== 'string' ||
    messageId.trim() !== messageId ||
    messageId.length < 1 ||
    messageId.length > 128
  ) {
    throw new Error('INVALID_WAGER_REQUESTED_MESSAGE_ID');
  }
  if (
    typeof occurredAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt))
  ) {
    throw new Error('INVALID_WAGER_REQUESTED_OCCURRED_AT');
  }
  if (!isRecord(data)) {
    throw new Error('INVALID_WAGER_REQUESTED_DATA');
  }
  const idempotencyKey = data.idempotencyKey;
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 128 ||
    idempotencyKey.trim() !== idempotencyKey
  ) {
    throw new Error('INVALID_WAGER_REQUESTED_IDEMPOTENCY_KEY');
  }

  const businessData: Record<string, unknown> = { ...data };
  delete businessData.idempotencyKey;
  const dto = plainToInstance(SubmitWageringTransactionDto, businessData);
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    stopAtFirstError: false,
  });
  if (errors.length > 0) {
    throw new Error('INVALID_WAGER_REQUESTED_BUSINESS_DATA');
  }

  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt,
    data: Object.assign(dto, { idempotencyKey }),
  };
}
