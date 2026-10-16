import { Migration } from '@mikro-orm/migrations';

export class Migration20261015025524_protect_ledger_immutability extends Migration {
  override name = 'Migration20261015025524_protect_ledger_immutability';

  override up(): void | Promise<void> {
    this.addSql(`
      CREATE OR REPLACE FUNCTION public.prevent_ledger_entries_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $ledger_guard$
      BEGIN
        RAISE EXCEPTION
          'ledger_entries is immutable; operation % is not allowed',
          TG_OP
          USING ERRCODE = '55000';

        RETURN NULL;
      END;
      $ledger_guard$;
    `);

    this.addSql(`
      CREATE TRIGGER trg_ledger_entries_immutable_rows
      BEFORE UPDATE OR DELETE ON public.ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION public.prevent_ledger_entries_mutation();
    `);

    this.addSql(`
      CREATE TRIGGER trg_ledger_entries_immutable_truncate
      BEFORE TRUNCATE ON public.ledger_entries
      FOR EACH STATEMENT
      EXECUTE FUNCTION public.prevent_ledger_entries_mutation();
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_ledger_entries_immutable_truncate
      ON public.ledger_entries;
    `);

    this.addSql(`
      DROP TRIGGER IF EXISTS trg_ledger_entries_immutable_rows
      ON public.ledger_entries;
    `);

    this.addSql(`
      DROP FUNCTION IF EXISTS public.prevent_ledger_entries_mutation();
    `);
  }
}
