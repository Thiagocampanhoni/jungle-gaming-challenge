import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { WagerTransaction } from './wagering/entities/wager-transaction.entity.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { Wallet } from './wallet/entities/wallet.entity.js';
import { LedgerEntry } from './ledger/entities/ledger-entry.entity.js';
import { OutboxMessage } from './outbox/entities/outbox-message.entity.js';
import { InboxMessage } from './inbox/entities/inbox-message.entity.js';
import { OutboxPublisherService } from './outbox/outbox-publisher.service.js';
import { WagerTransactionProcessor } from './wagering/wager-transaction.processor.service.js';
import { WagerTransactionConsumerService } from './wagering/wager-transaction-consumer.service.js';
import { WagerTransactionIntakeService } from './wagering/wager-transaction-intake-service.js';
import { WagerRequestedIngestionService } from './wagering/wager-requested-ingestion.service.js';
import { PendingReferenceRecoveryService } from './wagering/pending-reference-recovery.service.js';
import { WagerTransactionController } from './wagering/wager-transaction.controller.js';
import { WagerTransactionQueryController } from './wagering/wager-transaction-query.controller.js';
import { WagerTransactionQueryService } from './wagering/wager-transaction-query.service.js';
import { WalletController } from './wallet/wallet.controller.js';
import { WalletService } from './wallet/wallet.service.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { MetricsController } from './observability/metrics.controller.js';
import { MetricsService } from './observability/metrics.service.js';
import { RuntimeMetricsService } from './observability/runtime-metrics.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        driver: PostgreSqlDriver,
        clientUrl: configService.getOrThrow<string>('DATABASE_URL'),
        entities: [Wallet, WagerTransaction, LedgerEntry, OutboxMessage, InboxMessage],
      }),
    }),
  ],
  controllers: [
    AppController,
    WagerTransactionController,
    WagerTransactionQueryController,
    WalletController,
    HealthController,
    MetricsController,
  ],
  providers: [
    AppService,
    OutboxPublisherService,
    WagerTransactionProcessor,
    WagerTransactionConsumerService,
    WagerTransactionIntakeService,
    WagerTransactionQueryService,
    WagerRequestedIngestionService,
    PendingReferenceRecoveryService,
    WalletService,
    HealthService,
    MetricsService,
    RuntimeMetricsService,
  ],
})
export class AppModule {}
