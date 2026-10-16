import { Migration } from '@mikro-orm/migrations';

export class Migration20261016003000_wallet_identity_currency_version extends Migration {
  override name = 'Migration20261016003000_wallet_identity_currency_version';

  override up(): void | Promise<void> {
    /* Adiciona os campos de identidade, moeda e versão.
       Permanecem nullable até o backfill terminar. */
    this.addSql(`
      ALTER TABLE public.wallets
        ADD COLUMN player_id uuid NULL,
        ADD COLUMN currency varchar(3) NULL,
        ADD COLUMN version integer NULL;
    `);

    /* Compatibilidade para os dados legados deste desafio:
      cada wallet recebe um playerId distinto e a moeda BRL.
      Em produção, player_id deve vir de uma fonte de dados real. */
    this.addSql(`
      UPDATE public.wallets AS w
      SET
        player_id = w.id,
        currency = 'BRL',
        version = 1 + (
          SELECT COUNT(*)::integer
          FROM public.ledger_entries AS le
          WHERE le.wallet_id = w.id
        );
    `);

    /* Adiciona currency às transações e preenche o histórico
      usando a moeda da carteira relacionada. */
    this.addSql(`
      ALTER TABLE public.wager_transactions
        ADD COLUMN currency varchar(3) NULL;
    `);

    this.addSql(`
      UPDATE public.wager_transactions AS wt
      SET currency = w.currency
      FROM public.wallets AS w
      WHERE w.id = wt.wallet_id;
    `);

    this.addSql(`
      ALTER TABLE public.wager_transactions
        ALTER COLUMN currency SET NOT NULL;
    `);

    this.addSql(`
      ALTER TABLE public.wager_transactions
        ADD CONSTRAINT chk_wager_transactions_currency_format
        CHECK (currency ~ '^[A-Z]{3}$');
    `);

    /* Verifica se os saldos existentes e os saldos de abertura
       inferidos são consistentes antes de inserir lançamentos. */
    this.addSql(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM public.wallets AS w
          WHERE w.balance < 0
        ) THEN
          RAISE EXCEPTION
            'Wallet migration aborted: an existing wallet has a negative balance';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            SELECT
              w.id,
              w.balance
                - COALESCE(
                    SUM(
                      CASE
                        WHEN le.direction = 'CREDIT' THEN le.amount
                        WHEN le.direction = 'DEBIT' THEN -le.amount
                      END
                    ),
                    0
                  ) AS opening_balance
            FROM public.wallets AS w
            LEFT JOIN public.ledger_entries AS le
              ON le.wallet_id = w.id
            GROUP BY w.id, w.balance
          ) AS inferred
          WHERE inferred.opening_balance < 0
        ) THEN
          RAISE EXCEPTION
            'Wallet migration aborted: inferred opening balance is negative; reconcile the data first';
        END IF;
      END;
      $migration$;
    `);

    /* Registra o saldo inicial implícito no ledger.
      A transação OPENING e o respectivo crédito são inseridos
      na mesma execução SQL, dentro da transação da migration.
      Carteiras com saldo inicial zero não precisam desse lançamento. */
    this.addSql(`
      WITH movements AS (
        SELECT
          w.id AS wallet_id,
          w.currency,
          w.balance
            - COALESCE(
                SUM(
                  CASE
                    WHEN le.direction = 'CREDIT' THEN le.amount
                    WHEN le.direction = 'DEBIT' THEN -le.amount
                  END
                ),
                0
              ) AS opening_balance
        FROM public.wallets AS w
        LEFT JOIN public.ledger_entries AS le
          ON le.wallet_id = w.id
        GROUP BY w.id, w.balance, w.currency
      ),
      inserted_openings AS (
        INSERT INTO public.wager_transactions (
          id,
          wallet_id,
          external_transaction_id,
          idempotency_key,
          type,
          amount,
          currency,
          reference_transaction_id,
          status,
          payload_hash,
          error_code,
          processed_at,
          created_at,
          updated_at
        )
        SELECT
          gen_random_uuid(),
          m.wallet_id,
          'migration-opening:' || m.wallet_id::text,
          'migration-opening:' || m.wallet_id::text,
          'OPENING',
          m.opening_balance,
          m.currency,
          NULL,
          'APPLIED',
          repeat('0', 64),
          NULL,
          now(),
          now(),
          now()
        FROM movements AS m
        WHERE m.opening_balance > 0
        RETURNING id, wallet_id, amount
      )
      INSERT INTO public.ledger_entries (
        id,
        wallet_id,
        wager_transaction_id,
        direction,
        amount,
        reverses_entry_id,
        created_at
      )
      SELECT
        gen_random_uuid(),
        wallet_id,
        id,
        'CREDIT',
        amount,
        NULL,
        now()
      FROM inserted_openings;
    `);

    /* Torna obrigatórios os campos da carteira depois do backfill. */
    this.addSql(`
      ALTER TABLE public.wallets
        ALTER COLUMN player_id SET NOT NULL,
        ALTER COLUMN currency SET NOT NULL,
        ALTER COLUMN version SET NOT NULL,
        ALTER COLUMN version SET DEFAULT 1;
    `);

    /* Impõe as invariantes principais no banco. */
    this.addSql(`
      ALTER TABLE public.wallets
        ADD CONSTRAINT uq_wallets_player_currency
          UNIQUE (player_id, currency),
        ADD CONSTRAINT chk_wallets_balance_nonnegative
          CHECK (balance >= 0),
        ADD CONSTRAINT chk_wallets_version_positive
          CHECK (version >= 1),
        ADD CONSTRAINT chk_wallets_currency_format
          CHECK (currency ~ '^[A-Z]{3}$');
    `);
  }

  override down(): void | Promise<void> {
    /* Rollback controlado dos registros sintéticos OPENING.
       Os triggers são removidos temporariamente porque o ledger
       é imutável no uso normal da aplicação. */
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_ledger_entries_immutable_truncate
        ON public.ledger_entries;

      DROP TRIGGER IF EXISTS trg_ledger_entries_immutable_rows
        ON public.ledger_entries;
    `);

    this.addSql(`
      DELETE FROM public.outbox_messages AS o
      USING public.wager_transactions AS wt
      WHERE o.wager_transaction_id = wt.id
        AND wt.type = 'OPENING'
        AND wt.external_transaction_id LIKE 'migration-opening:%';
    `);

    this.addSql(`
      DELETE FROM public.ledger_entries AS le
      USING public.wager_transactions AS wt
      WHERE le.wager_transaction_id = wt.id
        AND wt.type = 'OPENING'
        AND wt.external_transaction_id LIKE 'migration-opening:%';
    `);

    this.addSql(`
      DELETE FROM public.wager_transactions
      WHERE type = 'OPENING'
        AND external_transaction_id LIKE 'migration-opening:%';
    `);

    /* Restaura os triggers de imutabilidade do ledger. */
    this.addSql(`
      CREATE TRIGGER trg_ledger_entries_immutable_rows
      BEFORE UPDATE OR DELETE ON public.ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION public.prevent_ledger_entries_mutation();

      CREATE TRIGGER trg_ledger_entries_immutable_truncate
      BEFORE TRUNCATE ON public.ledger_entries
      FOR EACH STATEMENT
      EXECUTE FUNCTION public.prevent_ledger_entries_mutation();
    `);

    /* Remove a coluna de moeda das transações. */
    this.addSql(`
      ALTER TABLE public.wager_transactions
        DROP CONSTRAINT IF EXISTS chk_wager_transactions_currency_format,
        DROP COLUMN IF EXISTS currency;
    `);

    /* Remove as constraints e colunas acrescentadas à carteira. */
    this.addSql(`
      ALTER TABLE public.wallets
        DROP CONSTRAINT IF EXISTS uq_wallets_player_currency,
        DROP CONSTRAINT IF EXISTS chk_wallets_balance_nonnegative,
        DROP CONSTRAINT IF EXISTS chk_wallets_version_positive,
        DROP CONSTRAINT IF EXISTS chk_wallets_currency_format,
        DROP COLUMN version,
        DROP COLUMN currency,
        DROP COLUMN player_id;
    `);
  }
}
