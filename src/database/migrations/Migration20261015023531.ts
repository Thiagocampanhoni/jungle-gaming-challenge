import { Migration } from '@mikro-orm/migrations';

export class Migration20261015023531 extends Migration {
  override name = 'Migration20261015023531';

  override up(): void | Promise<void> {
    this.addSql(`
      create table "ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "wager_transaction_id" uuid not null,
        "direction" varchar(6) not null,
        "amount" numeric(19,2) not null,
        "reverses_entry_id" uuid null,
        "created_at" timestamptz not null,
        primary key ("id")
      );
    `);

    this.addSql(`
      alter table "ledger_entries"
      add constraint "uq_ledger_entries_wager_transaction"
      unique ("wager_transaction_id");
    `);

    this.addSql(`
      alter table "ledger_entries"
      add constraint "uq_ledger_entries_reverses_entry"
      unique ("reverses_entry_id");
    `);

    this.addSql(`
      alter table "ledger_entries"
      add constraint "ledger_entries_wallet_id_foreign"
      foreign key ("wallet_id")
      references "wallets" ("id")
      on update restrict on delete restrict;
    `);

    this.addSql(`
      alter table "ledger_entries"
      add constraint "ledger_entries_wager_transaction_id_foreign"
      foreign key ("wager_transaction_id")
      references "wager_transactions" ("id")
      on update restrict on delete restrict;
    `);

    this.addSql(`
      alter table "ledger_entries"
      add constraint "ledger_entries_reverses_entry_id_foreign"
      foreign key ("reverses_entry_id")
      references "ledger_entries" ("id")
      on update restrict on delete restrict;
    `);

    this.addSql(`
      alter table "ledger_entries"
      add constraint "chk_ledger_entries_direction"
      check ("direction" in ('DEBIT', 'CREDIT'));
    `);

    this.addSql(`
      alter table "ledger_entries"
      add constraint "chk_ledger_entries_amount_positive"
      check ("amount" > 0);
    `);
  }

  override down(): void | Promise<void> {
    this.addSql('drop table "ledger_entries";');
  }
}
