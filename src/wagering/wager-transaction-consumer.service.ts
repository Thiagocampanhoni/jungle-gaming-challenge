import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { WagerTransactionProcessor } from './wager-transaction.processor.service.js';
import { WagerRequestedIngestionService } from './wager-requested-ingestion.service.js';
import { parseWagerRequestedEvent } from './wager-requested-event.js';
import { RuntimeMetricsService } from '../observability/runtime-metrics.service.js';

interface WagerReceivedEvent {
  outboxId: string;
  deduplicationKey: string;
  eventType: 'WAGER_TRANSACTION_RECEIVED';
  payload: {
    transactionId: string;
  };
}

const MAX_MESSAGES = 10;
const LONG_POLL_SECONDS = 10;
const VISIBILITY_TIMEOUT_SECONDS = 60;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

@Injectable()
export class WagerTransactionConsumerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WagerTransactionConsumerService.name);

  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  private running = false;
  private loopPromise?: Promise<void>;
  private readonly pollAbortController = new AbortController();

  constructor(
    private readonly processor: WagerTransactionProcessor,
    private readonly requestedIngestion: WagerRequestedIngestionService,
    config: ConfigService,
    @Optional() private readonly metrics?: RuntimeMetricsService,
  ) {
    this.queueUrl = config.getOrThrow<string>('SQS_QUEUE_URL');

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
    if (process.env.SQS_CONSUMER_ENABLED === 'false') {
      this.logger.log('SQS consumer disabled by configuration');
      return;
    }

    this.running = true;
    this.loopPromise = this.pollLoop();
    this.logger.log('SQS consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.pollAbortController.abort();

    if (this.loopPromise) {
      await this.loopPromise;
    }

    this.sqs.destroy();
    this.logger.log('SQS consumer stopped');
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: MAX_MESSAGES,
            WaitTimeSeconds: LONG_POLL_SECONDS,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: this.pollAbortController.signal },
        );

        for (const message of response.Messages ?? []) {
          if (!this.running) {
            break;
          }

          await this.handleMessage(message);
        }
      } catch (error: unknown) {
        if (!this.running) {
          break;
        }

        this.logger.error(
          'SQS polling failed',
          error instanceof Error ? error.stack : String(error),
        );

        await sleep(2000);
      }
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const receiptHandle = message.ReceiptHandle;

    if (!receiptHandle) {
      this.logger.warn('Received SQS message without a receipt handle');
      return;
    }

    try {
      if (!message.Body) {
        throw new Error('EMPTY_MESSAGE_BODY');
      }

      const parsed: unknown = JSON.parse(message.Body);
      const isExternal =
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        parsed.type === 'WagerTransactionRequested';

      let result: Awaited<ReturnType<WagerTransactionProcessor['process']>>;
      let audit: Record<string, string | boolean>;

      if (isExternal) {
        const event = parseWagerRequestedEvent(parsed);
        const handled = await this.requestedIngestion.receive(
          event,
          message.Body,
        );
        result = handled;
        audit = {
          eventType: 'WagerTransactionRequested',
          messageId: event.messageId,
          transactionId: handled.transactionId,
          duplicate: handled.duplicate,
        };
      } else {
        // Preserve the already-proven internal HTTP -> outbox -> FIFO route.
        const event = this.parseEvent(message.Body);
        const payloadHash = createHash('sha256')
          .update(message.Body)
          .digest('hex');
        result = await this.processor.process(event.payload.transactionId, {
          consumerName: 'wager-transaction-consumer',
          messageId: event.outboxId,
          payloadHash,
        });
        audit = {
          eventType: event.eventType,
          outboxId: event.outboxId,
          transactionId: event.payload.transactionId,
        };
      }

      if (result.disposition === 'ACK') {
        // ACK only after the encompassing SQL transaction has committed.
        await this.sqs.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
          }),
        );

        this.metrics?.acknowledged(result.status === 'ALREADY_APPLIED' || (isExternal && audit.duplicate === true));
        this.logger.log(
          JSON.stringify({
            event: 'wager_message_processed',
            ...audit,
            status: result.status,
          }),
        );
        return;
      }

      await this.retryLater(receiptHandle, message, result.reason);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const permanent =
        reason.startsWith('INVALID_') ||
        error instanceof SyntaxError ||
        reason === 'INBOX_MESSAGE_CONFLICT' ||
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof TypeError ||
        error instanceof RangeError;

      this.metrics?.processingFailure();
      this.metrics?.recordLockError(error);
      this.logger.warn(
        JSON.stringify({
          event: 'wager_message_processing_failed',
          classification: permanent ? 'PERMANENT' : 'TRANSIENT',
          reason: reason.slice(0, 500),
        }),
      );

      // Poison events remain unacknowledged until SQS redrive sends them to
      // the configured DLQ; never acknowledge a malformed financial command.
      await this.retryLater(receiptHandle, message, reason);
    } finally {
      this.metrics?.observeConsumerDuration(Number(process.hrtime.bigint() - startedAt) / 1e9);
    }
  }

  private parseEvent(body?: string): WagerReceivedEvent {
    if (!body) {
      throw new Error('EMPTY_MESSAGE_BODY');
    }

    const value: unknown = JSON.parse(body);

    if (typeof value !== 'object' || value === null) {
      throw new Error('INVALID_EVENT_FORMAT');
    }

    const event = value as Partial<WagerReceivedEvent>;

    if (
      event.eventType !== 'WAGER_TRANSACTION_RECEIVED' ||
      typeof event.outboxId !== 'string' ||
      typeof event.deduplicationKey !== 'string' ||
      typeof event.payload?.transactionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        event.payload.transactionId,
      )
    ) {
      throw new Error('INVALID_WAGER_RECEIVED_EVENT');
    }

    return event as WagerReceivedEvent;
  }

  private async retryLater(
    receiptHandle: string,
    message: Message,
    reason: string,
  ): Promise<void> {
    const receiveCount = Math.max(
      1,
      Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
    );

    const visibilityTimeout = Math.min(300, 2 ** Math.min(receiveCount, 8));

    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeout,
      }),
    );

    this.metrics?.retryScheduled();
    this.logger.warn(
      JSON.stringify({
        event: 'wager_message_retry_scheduled',
        receiveCount,
        visibilityTimeout,
        reason: reason.slice(0, 500),
      }),
    );
  }
}
