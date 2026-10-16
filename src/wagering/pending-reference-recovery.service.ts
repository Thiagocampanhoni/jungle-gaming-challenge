import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionProcessor } from './wager-transaction.processor.service.js';
import { RuntimeMetricsService } from '../observability/runtime-metrics.service.js';

const POLL_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 20;

interface DueJob {
  transactionId: string;
  attempts: number;
  expiresAt: Date | string;
  wagerStatus: string;
}

type RecoveryResult =
  | { action: 'IDLE' }
  | { action: 'RESOLVED' | 'REJECTED' | 'RETRY'; transactionId: string; reason?: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs independently of SQS (including after a message has entered the DLQ).
 * Due jobs are serialized using the wager row lock before the processor locks
 * any other row. Financial changes, events, job state and Inbox ACK commit
 * together. Multiple application instances can safely run this worker.
 */
@Injectable()
export class PendingReferenceRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceRecoveryService.name);
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly processor: WagerTransactionProcessor,
    @Optional() private readonly metrics?: RuntimeMetricsService,
  ) {}

  onModuleInit(): void {
    // Explicit opt-in so previous deployments and databases without the new
    // migration remain safe until the operator finishes the rollout.
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED !== 'true') {
      this.logger.log('Pending-reference recovery worker disabled');
      return;
    }
    this.running = true;
    this.loopPromise = this.runLoop();
    this.logger.log('Pending-reference recovery worker started');
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.loopPromise) await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.runOnce();
        if (result.action !== 'IDLE') {
          this.metrics?.recovery(result.action);
          this.logger.log(JSON.stringify({ event: 'pending_reference_recovery', ...result }));
        }
      } catch (error: unknown) {
        this.metrics?.recordLockError(error);
        this.logger.error(
          'Pending-reference recovery failed; SQL transaction rolled back',
          error instanceof Error ? error.stack : String(error),
        );
      }
      if (this.running) await delay(POLL_INTERVAL_MS);
    }
  }

  /** Public seam for deterministic unit/integration tests; one due job per call. */
  async runOnce(): Promise<RecoveryResult> {
    return this.em.transactional(async (tx) => {
      // Lock the wager first, matching the processor's lock order. SKIP LOCKED
      // prevents a second instance from handling the same job concurrently.
      const rows = await tx.execute<DueJob[]>(
        `
          SELECT j.transaction_id AS "transactionId", j.attempts,
                 j.expires_at AS "expiresAt", wt.status AS "wagerStatus"
          FROM public.pending_reference_jobs j
          JOIN public.wager_transactions wt ON wt.id = j.transaction_id
          WHERE j.status = 'PENDING' AND j.next_attempt_at <= now()
          ORDER BY j.next_attempt_at, j.transaction_id
          LIMIT 1
          FOR UPDATE OF wt SKIP LOCKED
        `,
      );
      const job = rows[0];
      if (!job) return { action: 'IDLE' };

      const finish = async (status: 'RESOLVED' | 'REJECTED', reason: string | null) => {
        await tx.execute(
          `UPDATE public.pending_reference_jobs
           SET status = ?, resolved_at = now(), updated_at = now(), last_error = ?
           WHERE transaction_id = ? AND status = 'PENDING'`,
          [status, reason, job.transactionId],
        );
        // When the message already entered the DLQ, no SQS redelivery remains
        // to mark the Inbox receipt as processed. Do so in the same SQL commit.
        await tx.execute(
          `UPDATE public.inbox_messages
           SET processed_at = now()
           WHERE transaction_id = ? AND processed_at IS NULL`,
          [job.transactionId],
        );
      };

      if (job.wagerStatus === 'APPLIED' || job.wagerStatus === 'REJECTED') {
        const action = job.wagerStatus === 'APPLIED' ? 'RESOLVED' : 'REJECTED';
        await finish(action, null);
        return { action, transactionId: job.transactionId };
      }

      const expiresAt = new Date(job.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new Error('INVALID_PENDING_REFERENCE_EXPIRY');
      }
      const attempts = Number(job.attempts);
      const exhausted = attempts >= MAX_ATTEMPTS;
      if (expiresAt.getTime() <= Date.now() || exhausted) {
        const reason = exhausted ? 'REFERENCE_RETRY_EXHAUSTED' : 'REFERENCE_EXPIRED';
        const outcome = await this.processor.rejectPendingReferenceInTransaction(
          tx, job.transactionId, reason,
        );
        // A concurrent update might have completed before we acquired the row
        // lock; the processor refuses to reject any already-terminal wager.
        const action = outcome === 'REJECTED' ? 'REJECTED' : 'RESOLVED';
        await finish(action, outcome === 'REJECTED' ? reason : null);
        return { action, transactionId: job.transactionId, reason };
      }

      const result = await this.processor.processWithTransaction(tx, job.transactionId);
      if (result.disposition === 'ACK') {
        const action = result.status === 'REJECTED' ? 'REJECTED' : 'RESOLVED';
        await finish(action, null);
        return { action, transactionId: job.transactionId };
      }

      const nextAttempts = attempts + 1;
      const nextDelaySeconds = Math.min(300, 2 ** Math.min(nextAttempts + 3, 9));
      await tx.execute(
        `UPDATE public.pending_reference_jobs
         SET attempts = ?,
             next_attempt_at = now() + (? * interval '1 second'),
             last_error = ?, updated_at = now()
         WHERE transaction_id = ? AND status = 'PENDING'`,
        [nextAttempts, nextDelaySeconds, result.reason, job.transactionId],
      );
      return { action: 'RETRY', transactionId: job.transactionId, reason: result.reason };
    });
  }
}
