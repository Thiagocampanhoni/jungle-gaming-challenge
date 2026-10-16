import { Migration } from '@mikro-orm/migrations';

/** Durable lifecycle for out-of-order REFUND and ROLLBACK commands. */
export class Migration20261016130000_pending_reference_recovery extends Migration {
  override name = 'Migration20261016130000_pending_reference_recovery';

  override up(): void {
    this.addSql(`
      CREATE TABLE public.pending_reference_jobs (
        transaction_id uuid PRIMARY KEY
          REFERENCES public.wager_transactions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz NULL,
        last_error varchar(255) NULL,
        CONSTRAINT chk_pending_reference_jobs_status
          CHECK (status IN ('PENDING', 'RESOLVED', 'REJECTED')),
        CONSTRAINT chk_pending_reference_jobs_attempts CHECK (attempts >= 0),
        CONSTRAINT chk_pending_reference_jobs_expiry CHECK (expires_at > created_at)
      );
    `);
    this.addSql(`
      CREATE INDEX idx_pending_reference_jobs_due
        ON public.pending_reference_jobs (next_attempt_at, transaction_id)
        WHERE status = 'PENDING';
    `);
    // Preserve unresolved references that existed before this deployment,
    // including messages which the FIFO queue has already moved to its DLQ.
    this.addSql(`
      INSERT INTO public.pending_reference_jobs (
        transaction_id, status, attempts, next_attempt_at,
        expires_at, created_at, updated_at
      )
      SELECT id, 'PENDING', 0, now(), now() + interval '24 hours', now(), now()
      FROM public.wager_transactions
      WHERE status = 'PENDING_REFERENCE'
      ON CONFLICT (transaction_id) DO NOTHING;
    `);
  }

  override down(): void {
    this.addSql(`
      DO $rollback$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.pending_reference_jobs LIMIT 1) THEN
          RAISE EXCEPTION 'Cannot rollback pending reference recovery with recorded jobs';
        END IF;
      END;
      $rollback$;
    `);
    this.addSql('DROP TABLE public.pending_reference_jobs;');
  }
}
