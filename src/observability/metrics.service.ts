import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { RuntimeMetricsService } from './runtime-metrics.service.js';

interface StatusCount { status: string; total: number | string }
interface CountRow { total: number | string }
interface LagRow { lagSeconds: number | string | null }
interface LatencyRow {
  averageSeconds: number | string | null;
  maximumSeconds: number | string | null;
}
interface RecoveryRow { totalAttempts: number | string | null }
interface QueueAttributes {
  ApproximateNumberOfMessages?: string;
  ApproximateNumberOfMessagesNotVisible?: string;
  RedrivePolicy?: string;
}
interface QueueStats {
  name: 'commands' | 'events';
  available: number;
  inflight: number;
  dlqConfigured: boolean;
  dlqAvailable: number;
  dlqInflight: number;
}

/** Prometheus text exporter: bounded label vocabulary, never includes IDs or financial payloads. */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private readonly sqs: SQSClient;
  private readonly commandQueue: string;
  private readonly eventsQueue?: string;

  constructor(
    private readonly em: EntityManager,
    config: ConfigService,
    private readonly runtime: RuntimeMetricsService,
  ) {
    this.commandQueue = config.getOrThrow<string>('SQS_QUEUE_URL');
    this.eventsQueue = config.get<string>('SQS_EVENTS_QUEUE_URL');
    const endpoint = config.get<string>('AWS_ENDPOINT_URL');
    this.sqs = new SQSClient({
      region: config.get<string>('AWS_REGION') ?? 'us-east-1',
      ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
    });
  }

  async collect(): Promise<string> {
    try {
      const [wagers, outbox, recoveries, inbox, lag, latency, recoveryAttempts, queues] = await Promise.all([
        this.em.execute<StatusCount[]>(
          'SELECT status, count(*)::int AS total FROM public.wager_transactions GROUP BY status',
        ),
        this.em.execute<StatusCount[]>(
          'SELECT status, count(*)::int AS total FROM public.outbox_messages GROUP BY status',
        ),
        this.em.execute<StatusCount[]>(
          'SELECT status, count(*)::int AS total FROM public.pending_reference_jobs GROUP BY status',
        ),
        this.em.execute<CountRow[]>(
          'SELECT count(*)::int AS total FROM public.inbox_messages WHERE processed_at IS NULL',
        ),
        this.em.execute<LagRow[]>(
          `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - created_at)))
             FILTER (WHERE status IN ('PENDING', 'PROCESSING')), 0)::float8 AS "lagSeconds"
           FROM public.outbox_messages`,
        ),
        this.em.execute<LatencyRow[]>(
          `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (processed_at - created_at))), 0)::float8 AS "averageSeconds",
                  COALESCE(MAX(EXTRACT(EPOCH FROM (processed_at - created_at))), 0)::float8 AS "maximumSeconds"
           FROM public.wager_transactions WHERE processed_at IS NOT NULL`,
        ),
        this.em.execute<RecoveryRow[]>(
          'SELECT COALESCE(SUM(attempts), 0)::int AS "totalAttempts" FROM public.pending_reference_jobs',
        ),
        this.readQueues(),
      ]);
      return this.render(wagers, outbox, recoveries, inbox, lag, latency, recoveryAttempts, queues);
    } catch (error: unknown) {
      // Prometheus must know that a scrape has failed, not consume partial data.
      this.logger.warn(`Metrics scrape failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
      throw new ServiceUnavailableException('Metrics temporarily unavailable');
    }
  }

  private async readQueues(): Promise<QueueStats[]> {
    const sources: { name: 'commands' | 'events'; url: string }[] = [
      { name: 'commands', url: this.commandQueue },
      ...(this.eventsQueue ? [{ name: 'events' as const, url: this.eventsQueue }] : []),
    ];
    return Promise.all(sources.map(async ({ name, url }): Promise<QueueStats> => {
      const source = await this.getAttributes(url, true);
      const arn = this.deadLetterArn(source.RedrivePolicy);
      if (!arn) {
        return {
          name,
          available: this.count(source.ApproximateNumberOfMessages),
          inflight: this.count(source.ApproximateNumberOfMessagesNotVisible),
          dlqConfigured: false,
          dlqAvailable: 0,
          dlqInflight: 0,
        };
      }
      const queueName = arn.split(':').at(-1);
      if (!queueName) throw new Error('Invalid DLQ ARN');
      const dlqUrl = await this.sqs.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
        { abortSignal: AbortSignal.timeout(3000) },
      );
      if (!dlqUrl.QueueUrl) throw new Error('Missing DLQ URL');
      const dlq = await this.getAttributes(dlqUrl.QueueUrl, false);
      return {
        name,
        available: this.count(source.ApproximateNumberOfMessages),
        inflight: this.count(source.ApproximateNumberOfMessagesNotVisible),
        dlqConfigured: true,
        dlqAvailable: this.count(dlq.ApproximateNumberOfMessages),
        dlqInflight: this.count(dlq.ApproximateNumberOfMessagesNotVisible),
      };
    }));
  }

  private async getAttributes(queueUrl: string, includeRedrive: boolean): Promise<QueueAttributes> {
    const result = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: includeRedrive
          ? ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'RedrivePolicy']
          : ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
      { abortSignal: AbortSignal.timeout(3000) },
    );
    if (!result.Attributes) throw new Error('Missing SQS attributes');
    return {
      ApproximateNumberOfMessages: result.Attributes.ApproximateNumberOfMessages,
      ApproximateNumberOfMessagesNotVisible: result.Attributes.ApproximateNumberOfMessagesNotVisible,
      RedrivePolicy: result.Attributes.RedrivePolicy,
    };
  }

  private deadLetterArn(redrivePolicy?: string): string | null {
    if (!redrivePolicy) return null;
    const policy: unknown = JSON.parse(redrivePolicy);
    if (typeof policy !== 'object' || policy === null || !('deadLetterTargetArn' in policy)) {
      throw new Error('Invalid SQS redrive policy');
    }
    const arn = (policy as { deadLetterTargetArn: unknown }).deadLetterTargetArn;
    if (typeof arn !== 'string' || !arn.startsWith('arn:')) throw new Error('Invalid DLQ ARN');
    return arn;
  }

  private count(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error('Invalid metric');
    return n;
  }

  private render(
    wagers: StatusCount[],
    outbox: StatusCount[],
    recoveries: StatusCount[],
    inbox: CountRow[],
    lag: LagRow[],
    latency: LatencyRow[],
    recoveryAttempts: RecoveryRow[],
    queues: QueueStats[],
  ): string {
    const counters = this.runtime.snapshot();
    const lines: string[] = [];
    const add = (name: string, help: string, type: 'gauge' | 'counter', samples: string[]) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
    };
    const statuses = (name: string, rows: StatusCount[], allowed: readonly string[]) => {
      const totals = new Map(rows.map((row) => [row.status, this.count(row.total)]));
      for (const status of totals.keys()) {
        if (!allowed.includes(status)) throw new Error(`Unexpected ${name} status`);
      }
      return allowed.map((status) => `${name}{status="${status}"} ${totals.get(status) ?? 0}`);
    };
    add('jungle_wager_transactions', 'Persisted wager transaction counts by internal status.', 'gauge',
      statuses('jungle_wager_transactions', wagers, ['RECEIVED', 'PENDING', 'PENDING_REFERENCE', 'APPLIED', 'REJECTED', 'FAILED']));
    add('jungle_outbox_messages', 'Persisted Outbox message counts by status.', 'gauge',
      statuses('jungle_outbox_messages', outbox, ['PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD']));
    add('jungle_pending_reference_jobs', 'Persisted pending reference recovery jobs.', 'gauge',
      statuses('jungle_pending_reference_jobs', recoveries, ['PENDING', 'RESOLVED', 'REJECTED']));
    add('jungle_inbox_unprocessed', 'Persisted Inbox receipts not yet acknowledged.', 'gauge',
      [`jungle_inbox_unprocessed ${this.count(inbox[0]?.total ?? 0)}`]);
    add('jungle_recovery_attempts_persisted', 'Persisted sum of pending reference retry attempts.', 'gauge',
      [`jungle_recovery_attempts_persisted ${this.count(recoveryAttempts[0]?.totalAttempts ?? 0)}`]);
    add('jungle_outbox_oldest_unpublished_age_seconds', 'Age of the oldest PENDING or PROCESSING Outbox entry.', 'gauge',
      [`jungle_outbox_oldest_unpublished_age_seconds ${this.count(lag[0]?.lagSeconds ?? 0)}`]);
    add('jungle_wager_completion_latency_seconds', 'Historic elapsed time from wager creation to terminal processing.', 'gauge', [
      `jungle_wager_completion_latency_seconds{stat="average"} ${this.count(latency[0]?.averageSeconds ?? 0)}`,
      `jungle_wager_completion_latency_seconds{stat="maximum"} ${this.count(latency[0]?.maximumSeconds ?? 0)}`,
    ]);
    add('jungle_sqs_messages', 'Approximate messages in the primary queues.', 'gauge', queues.flatMap((q) => [
      `jungle_sqs_messages{queue="${q.name}",state="available"} ${q.available}`,
      `jungle_sqs_messages{queue="${q.name}",state="inflight"} ${q.inflight}`,
    ]));
    add('jungle_sqs_dlq_configured', 'Whether an SQS dead-letter queue is configured.', 'gauge',
      queues.map((q) => `jungle_sqs_dlq_configured{queue="${q.name}"} ${q.dlqConfigured ? 1 : 0}`));
    add('jungle_sqs_dlq_messages', 'Approximate messages in configured dead-letter queues.', 'gauge',
      queues.filter((q) => q.dlqConfigured).flatMap((q) => [
        `jungle_sqs_dlq_messages{queue="${q.name}",state="available"} ${q.dlqAvailable}`,
        `jungle_sqs_dlq_messages{queue="${q.name}",state="inflight"} ${q.dlqInflight}`,
      ]));
    const processCounters: [string, string, number][] = [
      ['jungle_consumer_acks_total', 'SQS messages acknowledged by this process.', counters.messagesAcknowledged],
      ['jungle_consumer_duplicates_total', 'Duplicate SQS messages detected by this process.', counters.duplicateMessages],
      ['jungle_consumer_retries_total', 'SQS retries scheduled by this process.', counters.retriesScheduled],
      ['jungle_consumer_failures_total', 'SQS handling exceptions in this process.', counters.processingFailures],
      ['jungle_lock_conflicts_total', 'PostgreSQL lock and serialization errors observed by this process.', counters.lockConflicts],
      ['jungle_outbox_published_total', 'Outbox messages published by this process.', counters.outboxPublished],
      ['jungle_outbox_failures_total', 'Outbox publication failures observed by this process.', counters.outboxFailures],
      ['jungle_recovery_retries_total', 'Recovery retries observed by this process.', counters.recoveryRetried],
      ['jungle_recovery_resolved_total', 'Recovery jobs resolved by this process.', counters.recoveryResolved],
      ['jungle_recovery_rejected_total', 'Recovery jobs rejected by this process.', counters.recoveryRejected],
      ['jungle_consumer_duration_seconds_count', 'Number of SQS handler durations observed by this process.', counters.consumerDurationCount],
    ];
    for (const [name, help, value] of processCounters) add(name, help, 'counter', [`${name} ${value}`]);
    add('jungle_consumer_duration_seconds_sum', 'Cumulative SQS handler duration in seconds for this process.', 'counter',
      [`jungle_consumer_duration_seconds_sum ${counters.consumerDurationSumSeconds}`]);
    return `${lines.join('\n')}\n`;
  }

  onModuleDestroy(): void { this.sqs.destroy(); }
}
