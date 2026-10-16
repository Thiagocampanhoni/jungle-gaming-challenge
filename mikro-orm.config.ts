import 'dotenv/config';
import 'reflect-metadata';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Wallet } from './src/wallet/entities/wallet.entity.js';
import { WagerTransaction } from './src/wagering/entities/wager-transaction.entity.js';
import { LedgerEntry } from './src/ledger/entities/ledger-entry.entity.js';
import { OutboxMessage } from './src/outbox/entities/outbox-message.entity.js';
import { InboxMessage } from './src/inbox/entities/inbox-message.entity.js';

const clientUrl = process.env.DATABASE_URL;

if (!clientUrl) {
  throw new Error('DATABASE_URL não está definida no arquivo .env');
}

export default defineConfig({
  clientUrl,
  entities: [Wallet, WagerTransaction, LedgerEntry, OutboxMessage, InboxMessage],
  metadataProvider: ReflectMetadataProvider,
  extensions: [Migrator],
  migrations: {
    path: './dist/database/migrations',
    pathTs: './src/database/migrations',
    glob: '!(*.d).{js,ts,cjs}',
    emit: 'ts',
    transactional: true,
    allOrNothing: true,
    dropTables: false,
  },
});
