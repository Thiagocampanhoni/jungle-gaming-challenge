import { Injectable } from '@nestjs/common';

export interface RuntimeMetricsSnapshot {
  messagesAcknowledged: number;
  duplicateMessages: number;
  retriesScheduled: number;
  processingFailures: number;
  lockConflicts: number;
  outboxPublished: number;
  outboxFailures: number;
  recoveryRetried: number;
  recoveryResolved: number;
  recoveryRejected: number;
  consumerDurationCount: number;
  consumerDurationSumSeconds: number;
}

/**
 * Process-local operational counters. Not an idempotency mechanism and not a
 * persistent source of financial truth. All metrics reset when this pod exits.
 * PostgreSQL gauges and SQS queue gauges are collected separately.
 */
@Injectable()
export class RuntimeMetricsService {
  private readonly counts: RuntimeMetricsSnapshot = {
    messagesAcknowledged: 0,
    duplicateMessages: 0,
    retriesScheduled: 0,
    processingFailures: 0,
    lockConflicts: 0,
    outboxPublished: 0,
    outboxFailures: 0,
    recoveryRetried: 0,
    recoveryResolved: 0,
    recoveryRejected: 0,
    consumerDurationCount: 0,
    consumerDurationSumSeconds: 0,
  };

  acknowledged(duplicate: boolean): void {
    this.counts.messagesAcknowledged += 1;
    if (duplicate) this.counts.duplicateMessages += 1;
  }

  retryScheduled(): void { this.counts.retriesScheduled += 1; }
  processingFailure(): void { this.counts.processingFailures += 1; }
  outboxPublished(): void { this.counts.outboxPublished += 1; }
  outboxFailure(): void { this.counts.outboxFailures += 1; }

  recovery(action: 'RETRY' | 'RESOLVED' | 'REJECTED'): void {
    if (action === 'RETRY') this.counts.recoveryRetried += 1;
    if (action === 'RESOLVED') this.counts.recoveryResolved += 1;
    if (action === 'REJECTED') this.counts.recoveryRejected += 1;
  }

  recordLockError(error: unknown): void {
    // PostgreSQL: lock_not_available, deadlock_detected, serialization_failure.
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
    if (code === '55P03' || code === '40P01' || code === '40001') {
      this.counts.lockConflicts += 1;
    }
  }

  observeConsumerDuration(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.counts.consumerDurationCount += 1;
    this.counts.consumerDurationSumSeconds += seconds;
  }

  snapshot(): RuntimeMetricsSnapshot {
    return { ...this.counts };
  }
}
