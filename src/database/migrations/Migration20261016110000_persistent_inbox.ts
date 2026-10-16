import { Migration } from '@mikro-orm/migrations';

/** Durable consumer receipts. No existing financial data is changed. */
export class Migration20261016110000_persistent_inbox extends Migration {
  override name = 'Migration20261016110000_persistent_inbox';

  override up(): void {
    this.addSql(`
      CREATE TABLE public.inbox_messages (
        consumer_name varchar(128) NOT NULL,
        message_id varchar(128) NOT NULL,
        transaction_id uuid NOT NULL,
        payload_hash varchar(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz NULL,
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_messages_transaction_id_foreign
          FOREIGN KEY (transaction_id)
          REFERENCES public.wager_transactions(id)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        CONSTRAINT chk_inbox_messages_payload_hash
          CHECK (payload_hash ~ '^[0-9a-f]{64}$')
      );
    `);
    this.addSql(`
      CREATE INDEX idx_inbox_messages_transaction_id
      ON public.inbox_messages (transaction_id);
    `);
    this.addSql(`
      CREATE INDEX idx_inbox_messages_unprocessed
      ON public.inbox_messages (received_at)
      WHERE processed_at IS NULL;
    `);
  }

  override down(): void {
    // Prevent dropping deduplication state once messages have been recorded.
    this.addSql(`
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.inbox_messages LIMIT 1) THEN
          RAISE EXCEPTION
            'Cannot rollback persistent inbox while message receipts exist';
        END IF;
      END;
      $migration$;
    `);
    this.addSql('DROP TABLE public.inbox_messages;');
  }
}
