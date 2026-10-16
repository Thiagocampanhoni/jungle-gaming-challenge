import { Migration } from '@mikro-orm/migrations';

/** Expands the existing schema without replacing or mutating ledger entries. */
export class Migration20261016080000_provider_identity extends Migration {
  override name = 'Migration20261016080000_provider_identity';

  override up(): void {
    this.addSql(`
      ALTER TABLE public.wager_transactions
        ADD COLUMN provider_id varchar(128),
        ADD COLUMN player_id uuid,
        ADD COLUMN round_id varchar(128),
        ADD COLUMN game_id varchar(128);
    `);

    // Historic operations were created by the pre-provider API.
    // Preserve their shared namespace and link to the player of the wallet.
    this.addSql(`
      UPDATE public.wager_transactions AS wt
      SET provider_id = CASE WHEN wt.type = 'OPENING' THEN 'internal' ELSE 'legacy' END,
          player_id = w.player_id,
          round_id = 'legacy',
          game_id = 'legacy'
      FROM public.wallets AS w
      WHERE wt.wallet_id = w.id;
    `);

    this.addSql(`
      ALTER TABLE public.wager_transactions
        ALTER COLUMN provider_id SET NOT NULL,
        ALTER COLUMN player_id SET NOT NULL,
        ALTER COLUMN round_id SET NOT NULL,
        ALTER COLUMN game_id SET NOT NULL;
    `);

    // Remove global uniqueness only after all historic rows are populated.
    this.addSql(`
      ALTER TABLE public.wager_transactions
        DROP CONSTRAINT uq_wager_transactions_external_id,
        DROP CONSTRAINT uq_wager_transactions_idempotency_key,
        ADD CONSTRAINT uq_wager_transactions_provider_external_id
          UNIQUE (provider_id, external_transaction_id),
        ADD CONSTRAINT uq_wager_transactions_provider_idempotency_key
          UNIQUE (provider_id, idempotency_key),
        ADD CONSTRAINT chk_wager_transactions_provider_nonempty
          CHECK (length(btrim(provider_id)) > 0),
        ADD CONSTRAINT chk_wager_transactions_round_nonempty
          CHECK (length(btrim(round_id)) > 0),
        ADD CONSTRAINT chk_wager_transactions_game_nonempty
          CHECK (length(btrim(game_id)) > 0);
    `);

    this.addSql(`
      CREATE INDEX idx_wager_transactions_provider_round
      ON public.wager_transactions (provider_id, player_id, round_id);
    `);
  }

  override down(): void {
    // Reinstating global uniqueness is not possible after different providers
    // reuse the same external ID/key. Fail safely rather than delete history.
    this.addSql(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM public.wager_transactions
          GROUP BY external_transaction_id HAVING count(*) > 1
        ) OR EXISTS (
          SELECT 1 FROM public.wager_transactions
          GROUP BY idempotency_key HAVING count(*) > 1
        ) THEN
          RAISE EXCEPTION
            'Cannot rollback provider identity: global transaction identifiers now overlap across providers';
        END IF;
      END;
      $migration$;
    `);

    this.addSql(`
      DROP INDEX public.idx_wager_transactions_provider_round;
    `);

    this.addSql(`
      ALTER TABLE public.wager_transactions
        DROP CONSTRAINT uq_wager_transactions_provider_external_id,
        DROP CONSTRAINT uq_wager_transactions_provider_idempotency_key,
        DROP CONSTRAINT chk_wager_transactions_provider_nonempty,
        DROP CONSTRAINT chk_wager_transactions_round_nonempty,
        DROP CONSTRAINT chk_wager_transactions_game_nonempty,
        ADD CONSTRAINT uq_wager_transactions_external_id
          UNIQUE (external_transaction_id),
        ADD CONSTRAINT uq_wager_transactions_idempotency_key
          UNIQUE (idempotency_key),
        DROP COLUMN provider_id,
        DROP COLUMN player_id,
        DROP COLUMN round_id,
        DROP COLUMN game_id;
    `);
  }
}
