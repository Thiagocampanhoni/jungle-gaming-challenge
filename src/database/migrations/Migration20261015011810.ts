import { Migration } from '@mikro-orm/migrations';

export class Migration20261015011810 extends Migration {
  override name = 'Migration20261015011810';

  override up(): void | Promise<void> {
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "external_transaction_id" varchar(128) not null,
        "idempotency_key" varchar(128) not null,
        "type" varchar(16) not null,
        "amount" numeric(19,2) not null,
        "reference_transaction_id" varchar(128) null,
        "status" varchar(24) not null default 'RECEIVED',
        "payload_hash" varchar(64) not null,
        "error_code" varchar(255) null,
        "processed_at" timestamptz null,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        primary key ("id")
      );
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "uq_wager_transactions_idempotency_key"
      unique ("idempotency_key");
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "uq_wager_transactions_external_id"
      unique ("external_transaction_id");
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "wager_transactions_wallet_id_foreign"
      foreign key ("wallet_id") references "wallets" ("id")
      on update restrict on delete restrict;
    `);

    this.addSql(`
      alter table "wager_transactions"
      add constraint "chk_wager_transactions_amount_positive"
      check (amount > 0);
    `);
  }

  override down(): void | Promise<void> {
    this.addSql('drop table "wager_transactions";');
  }
}
