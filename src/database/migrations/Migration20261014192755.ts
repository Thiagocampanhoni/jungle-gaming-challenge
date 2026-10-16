import { Migration } from '@mikro-orm/migrations';

export class Migration20261014192755 extends Migration {
  override name = 'Migration20261014192755';

  override up(): void | Promise<void> {
    this.addSql(
      `create table "wallets" (
        "id" uuid not null,
        "balance" numeric(19,2) not null default '0.00',
        "created_at" timestamptz not null,
        primary key ("id")
      );`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql('drop table "wallets";');
  }
}
