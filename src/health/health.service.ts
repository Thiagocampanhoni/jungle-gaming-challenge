import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface HealthStatus {
  status: 'ok' | 'unavailable';
  checks?: {
    postgres: 'up' | 'down';
    sqs: 'up' | 'down';
  };
}

/**
 * Liveness does not depend on infrastructure. Readiness probes the same
 * PostgreSQL and SQS endpoints configured for the financial workers.
 * Error details and connection strings must never be returned to callers.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly sqs: SQSClient;
  private readonly queueUrls: string[];

  constructor(
    private readonly em: EntityManager,
    config: ConfigService,
  ) {
    const commandsQueue = config.getOrThrow<string>('SQS_QUEUE_URL');
    const eventsQueue = config.get<string>('SQS_EVENTS_QUEUE_URL');
    this.queueUrls = eventsQueue
      ? [commandsQueue, eventsQueue]
      : [commandsQueue];

    const endpoint = config.get<string>('AWS_ENDPOINT_URL');
    this.sqs = new SQSClient({
      region: config.get<string>('AWS_REGION') ?? 'us-east-1',
      ...(endpoint
        ? {
            endpoint,
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          }
        : {}),
    });
  }

  live(): HealthStatus {
    return { status: 'ok' };
  }

  async ready(): Promise<HealthStatus> {
    // Probe both dependencies regardless of the first outcome; do not expose
    // stack traces, AWS endpoints or database connection strings.
    const [postgres, sqs] = await Promise.all([
      this.checkPostgres(),
      this.checkSqs(),
    ]);
    const result: HealthStatus = {
      status: postgres && sqs ? 'ok' : 'unavailable',
      checks: {
        postgres: postgres ? 'up' : 'down',
        sqs: sqs ? 'up' : 'down',
      },
    };
    if (result.status !== 'ok') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await this.em.execute('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  private async checkSqs(): Promise<boolean> {
    try {
      await Promise.all(
        this.queueUrls.map((queueUrl) =>
          this.sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: ['QueueArn'],
            }),
            { abortSignal: AbortSignal.timeout(3000) },
          ),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }
}
