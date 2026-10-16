import { Migration } from '@mikro-orm/migrations';

export class Migration20261015044335 extends Migration {
  override name = 'Migration20261015044335';

  override up(): void | Promise<void> {
    this.addSql(`
      CREATE TABLE "outbox_messages" (
        "id" uuid NOT NULL,
        "wager_transaction_id" uuid NOT NULL,
        "deduplication_key" varchar(64) NOT NULL,
        "event_type" varchar(64) NOT NULL,
        "payload" jsonb NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "available_at" timestamptz NOT NULL,
        "locked_at" timestamptz NULL,
        "last_error" varchar(1000) NULL,
        "published_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL,
        PRIMARY KEY ("id")
      );
    `);

    this.addSql(`
      ALTER TABLE "outbox_messages"
      ADD CONSTRAINT "uq_outbox_messages_deduplication_key"
      UNIQUE ("deduplication_key");
    `);

    this.addSql(`
      ALTER TABLE "outbox_messages"
      ADD CONSTRAINT "outbox_messages_wager_transaction_id_foreign"
      FOREIGN KEY ("wager_transaction_id")
      REFERENCES "wager_transactions" ("id")
      ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);

    this.addSql(`
      ALTER TABLE "outbox_messages"
      ADD CONSTRAINT "chk_outbox_messages_attempts_nonnegative"
      CHECK ("attempts" >= 0);
    `);
  }

  override down(): void | Promise<void> {
    this.addSql('DROP TABLE "outbox_messages";');
  }
}
