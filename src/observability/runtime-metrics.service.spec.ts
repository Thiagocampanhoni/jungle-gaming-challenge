import { describe, expect, it } from 'vitest';
import { RuntimeMetricsService } from './runtime-metrics.service.js';

describe('RuntimeMetricsService', () => {
  it('starts with a zeroed snapshot', () => {
    const metrics = new RuntimeMetricsService();
    expect(Object.values(metrics.snapshot()).every((value) => value === 0)).toBe(true);
  });

  it('counts ACKs and duplicate detections separately', () => {
    const metrics = new RuntimeMetricsService();
    metrics.acknowledged(false);
    metrics.acknowledged(true);
    expect(metrics.snapshot().messagesAcknowledged).toBe(2);
    expect(metrics.snapshot().duplicateMessages).toBe(1);
  });

  it('records recovery outcomes and persistence-independent SQS metrics', () => {
    const metrics = new RuntimeMetricsService();
    metrics.retryScheduled();
    metrics.processingFailure();
    metrics.outboxPublished();
    metrics.outboxFailure();
    metrics.recovery('RETRY');
    metrics.recovery('RESOLVED');
    metrics.recovery('REJECTED');
    expect(metrics.snapshot()).toMatchObject({
      retriesScheduled: 1,
      processingFailures: 1,
      outboxPublished: 1,
      outboxFailures: 1,
      recoveryRetried: 1,
      recoveryResolved: 1,
      recoveryRejected: 1,
    });
  });

  it.each(['55P03', '40P01', '40001'])('identifies PostgreSQL lock error %s', (code) => {
    const metrics = new RuntimeMetricsService();
    metrics.recordLockError({ code });
    expect(metrics.snapshot().lockConflicts).toBe(1);
  });

  it('does not classify unrelated failures as lock conflicts', () => {
    const metrics = new RuntimeMetricsService();
    metrics.recordLockError(new Error('UNAVAILABLE'));
    metrics.recordLockError({ code: '23505' });
    metrics.recordLockError(null);
    expect(metrics.snapshot().lockConflicts).toBe(0);
  });

  it('observes only finite non-negative durations', () => {
    const metrics = new RuntimeMetricsService();
    metrics.observeConsumerDuration(0.125);
    metrics.observeConsumerDuration(0.25);
    metrics.observeConsumerDuration(-1);
    metrics.observeConsumerDuration(Infinity);
    expect(metrics.snapshot().consumerDurationCount).toBe(2);
    expect(metrics.snapshot().consumerDurationSumSeconds).toBeCloseTo(0.375);
  });

  it('returns an isolated snapshot', () => {
    const metrics = new RuntimeMetricsService();
    const copy = metrics.snapshot();
    copy.messagesAcknowledged = 50;
    expect(metrics.snapshot().messagesAcknowledged).toBe(0);
  });
});
