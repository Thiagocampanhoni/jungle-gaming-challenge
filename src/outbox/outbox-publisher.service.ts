import {
  Injectable,
  Optional,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { RuntimeMetricsService } from '../observability/runtime-metrics.service.js';

interface ClaimedOutboxMessage {
  id: string;
  deduplicationKey: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  walletId: string;
}

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 8;
const LOCK_TIMEOUT_SECONDS = 60;
const IDLE_DELAY_MS = 1000;
const ERROR_DELAY_MS = 2000;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;
  private readonly eventsQueueUrl?: string;

  private running = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    config: ConfigService,
    @Optional() private readonly metrics?: RuntimeMetricsService,
  ) {
    this.queueUrl = config.getOrThrow<string>('SQS_QUEUE_URL');
    this.eventsQueueUrl = config.get<string>('SQS_EVENTS_QUEUE_URL');
    if (this.eventsQueueUrl && this.eventsQueueUrl === this.queueUrl) {
      throw new Error('SQS_EVENTS_QUEUE_URL must differ from SQS_QUEUE_URL');
    }

    const endpoint = config.get<string>('AWS_ENDPOINT_URL');
    const region = config.get<string>('AWS_REGION') ?? 'us-east-1';

    this.sqs = new SQSClient({
      region,
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: 'test',
              secretAccessKey: 'test',
            },
          }
        : {}),
    });
  }

  onModuleInit(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED === 'false') {
      this.logger.log('Outbox publisher disabled by configuration');
      return;
    }

    if (!this.eventsQueueUrl) {
      this.logger.warn('SQS_EVENTS_QUEUE_URL is unset: domain events will remain PENDING in the Outbox');
    }
    this.running = true;
    this.loopPromise = this.runLoop();
    this.logger.log('Outbox publisher started');
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;

    if (this.loopPromise) {
      await this.loopPromise;
    }

    this.sqs.destroy();
    this.logger.log('Outbox publisher stopped');
  }

  async publishBatch(): Promise<number> {
    const messages = await this.claimBatch();

    for (const message of messages) {
      if (message.attempts > MAX_ATTEMPTS) {
        await this.markDead(
          message.id,
          'Maximum publication attempts exceeded after lease recovery',
        );
        continue;
      }

      try {
        const isReceiveCommand = message.eventType === 'WAGER_TRANSACTION_RECEIVED';
        const destination = isReceiveCommand ? this.queueUrl : this.eventsQueueUrl;
        if (!destination) {
          throw new Error('SQS_EVENTS_QUEUE_URL is not configured');
        }
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: destination,
            ...(destination.endsWith('.fifo') ? {
              MessageGroupId: message.walletId,
              MessageDeduplicationId: message.deduplicationKey,
            } : {}),
            // Existing command format is unchanged; domain events are
            // published directly as versioned JSON envelopes.
            MessageBody: JSON.stringify(
              isReceiveCommand
                ? {
                    outboxId: message.id,
                    deduplicationKey: message.deduplicationKey,
                    eventType: message.eventType,
                    payload: message.payload,
                  }
                : message.payload,
            ),
          }),
        );

        await this.em.execute(
          `
            UPDATE public.outbox_messages
            SET status = 'PUBLISHED',
                published_at = now(),
                locked_at = NULL,
                last_error = NULL,
                updated_at = now()
            WHERE id = ? AND status = 'PROCESSING'
          `,
          [message.id],
        );

        this.metrics?.outboxPublished();
        this.logger.log(`Published outbox message ${message.id}`);
      } catch (error: unknown) {
        await this.recordFailure(message, error);
      }
    }

    return messages.length;
  }

  private async claimBatch(): Promise<ClaimedOutboxMessage[]> {
    return this.em.transactional(
      async (tx) => {
        await tx.execute(
          `
            UPDATE public.outbox_messages
            SET status = 'DEAD',
                locked_at = NULL,
                last_error = COALESCE(
                  last_error,
                  'Maximum attempts reached before lease recovery'
                ),
                updated_at = now()
            WHERE status = 'PROCESSING'
              AND attempts >= ?
              AND locked_at < now() - (? * interval '1 second')
          `,
          [MAX_ATTEMPTS, LOCK_TIMEOUT_SECONDS],
        );

        return tx.execute<ClaimedOutboxMessage[]>(
          `
            WITH candidates AS (
              SELECT id
              FROM public.outbox_messages
              WHERE attempts < ?
                AND (? OR event_type = 'WAGER_TRANSACTION_RECEIVED')
                AND (
                  (status = 'PENDING' AND available_at <= now())
                  OR (
                    status = 'PROCESSING'
                    AND locked_at < now() - (? * interval '1 second')
                  )
                )
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT ?
            )
            UPDATE public.outbox_messages AS message
            SET status = 'PROCESSING',
                locked_at = now(),
                attempts = message.attempts + 1,
                updated_at = now()
            FROM candidates
            WHERE message.id = candidates.id
            RETURNING
              message.id,
              message.deduplication_key AS "deduplicationKey",
              message.event_type AS "eventType",
              message.payload,
              message.attempts,
              (SELECT wt.wallet_id::text
               FROM public.wager_transactions AS wt
               WHERE wt.id = message.wager_transaction_id) AS "walletId"
          `,
          [MAX_ATTEMPTS, Boolean(this.eventsQueueUrl), LOCK_TIMEOUT_SECONDS, BATCH_SIZE],
        );
      },
      { clear: true },
    );
  }

  private async recordFailure(
    message: ClaimedOutboxMessage,
    error: unknown,
  ): Promise<void> {
    this.metrics?.outboxFailure();
    this.metrics?.recordLockError(error);
    const errorMessage = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 1000);

    const exhausted = message.attempts >= MAX_ATTEMPTS;

    const retryDelaySeconds = Math.min(
      300,
      2 ** Math.min(message.attempts - 1, 8),
    );

    await this.em.execute(
      `
      UPDATE public.outbox_messages
      SET status = ?,
          locked_at = NULL,
          available_at = now() + (? * interval '1 second'),
          last_error = ?,
          updated_at = now()
      WHERE id = ? AND status = 'PROCESSING'
    `,
      [
        exhausted ? 'DEAD' : 'PENDING',
        retryDelaySeconds,
        errorMessage,
        message.id,
      ],
    );

    if (exhausted) {
      this.logger.error(
        `Outbox message ${message.id} moved to DEAD after ${message.attempts} attempts: ${errorMessage}`,
      );
      return;
    }

    this.logger.warn(
      `Outbox message ${message.id} failed on attempt ${message.attempts}; retry scheduled in ${retryDelaySeconds}s`,
    );
  }

  private async markDead(id: string, reason: string): Promise<void> {
    await this.em.execute(
      `
        UPDATE public.outbox_messages
        SET status = 'DEAD',
            locked_at = NULL,
            last_error = ?,
            updated_at = now()
        WHERE id = ? AND status = 'PROCESSING'
      `,
      [id, reason.slice(0, 1000)],
    );

    this.logger.error(`Outbox message ${id} moved to DEAD: ${reason}`);
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.publishBatch();

        if (processed === 0) {
          await sleep(IDLE_DELAY_MS);
        }
      } catch (error: unknown) {
        this.metrics?.recordLockError(error);
        this.logger.error(
          'Outbox polling failed',
          error instanceof Error ? error.stack : String(error),
        );

        await sleep(ERROR_DELAY_MS);
      }
    }
  }
}
