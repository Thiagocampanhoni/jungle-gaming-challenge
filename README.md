# Jungle Gaming — Distributed Wagering Processor

Serviço de processamento de transações financeiras de apostas, construído com **Bun, TypeScript, NestJS, PostgreSQL, MikroORM e AWS SQS** (LocalStack no ambiente de desenvolvimento). O foco é integridade monetária, idempotência persistente e recuperação em um ambiente com entrega *at-least-once*.

> **Escopo da evidência:** implementação revisada até o Patch 07D, conforme o código e as execuções locais de 16/10/2026. O pipeline automatizado inclui testes unitários e um E2E básico; os cenários com PostgreSQL e LocalStack reais foram exercitados manualmente em ambiente isolado. Eles **não** são uma suíte de integração completa executada por `bun run test:e2e`.

## Arquitetura em resumo

```text
HTTP / Provedor externo
       |
       v
Intake / validação / Idempotency-Key
       |
       v
PostgreSQL: wagers + Outbox (mesmo commit)
       |
       v
Outbox Publisher -- SQS FIFO (comandos) --> Consumer / Inbox
                                                 |
                                                 v
                                  Transação SQL + lock de wallet
                                                 |
                                    +------------+-----------+
                                    |                        |
                                saldo/ledger           status + eventos
                                    |                        |
                                    +------------+-----------+
                                                 |
                                      Outbox de eventos
                                                 |
                                                 v
                                         SQS FIFO (eventos)
```

O PostgreSQL é a fonte de verdade; SQS FIFO otimiza ordenação por carteira, mas **não** substitui transações, locks e restrições de unicidade no banco. Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para trade-offs e limitações.

## Requisitos locais

- **Bun 1.x** (runtime, gerenciador de pacotes e execução do Vitest).
- **Docker Desktop** com Docker Compose.
- Portas **5432** (PostgreSQL), **4566** (LocalStack) e **3000** (API) disponíveis.
- PowerShell nos exemplos abaixo; comandos Bun e Docker também podem ser adaptados para outros sistemas.

## Início rápido — ambiente de desenvolvimento

Na raiz do projeto:

```powershell
bun install
docker compose up -d
docker compose ps
```

Crie um arquivo `.env` local a partir do `.env.example` e confira seus valores. Como as URLs SQS precisam apontar para filas existentes, provisione **duas filas FIFO separadas**; cada chamada também cria a DLQ da respectiva fila:

```powershell
bun .\scripts\provision-sqs.mjs wagering-wallet-inbox
bun .\scripts\provision-sqs.mjs wagering-wallet-events
```

Para LocalStack, use os `queueUrl` exibidos pelos comandos. Configuração ilustrativa de desenvolvimento (não use as credenciais ou o banco abaixo em produção):

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://jungle:jungle_local_dev@localhost:5432/jungle_gaming
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4566
SQS_QUEUE_URL=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wagering-wallet-inbox.fifo
SQS_EVENTS_QUEUE_URL=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wagering-wallet-events.fifo
SQS_CONSUMER_ENABLED=false
OUTBOX_PUBLISHER_ENABLED=false
PENDING_REFERENCE_WORKER_ENABLED=false
```

> Os três switches acima mantêm os workers desligados durante a preparação. Somente ative processamento após aplicar as migrations. O worker de referências exige `PENDING_REFERENCE_WORKER_ENABLED=true`; consumer e publisher iniciam por padrão quando não estiverem explicitamente `false`.

Aplique o schema versionado e verifique seu estado:

```powershell
bunx mikro-orm migration:pending --config ./mikro-orm.config.ts
bunx mikro-orm migration:up --config ./mikro-orm.config.ts
bun run build
bun run start:dev
```

Os arquivos de migration ficam em `src/database/migrations/`. Não use um banco preexistente com dados reais para testes financeiros. O Compose inclui volumes persistentes; `docker compose down -v` apagaria dados do ambiente Docker.

Para processar transações de ponta a ponta, ajuste as três variáveis para `true` na configuração local, reinicie a aplicação e confirme os logs dos workers. O publisher de eventos exige `SQS_EVENTS_QUEUE_URL` distinta de `SQS_QUEUE_URL`.

## API HTTP

| Método | Rota | Finalidade |
|---|---|---|
| `POST` | `/wallets` | Criar carteira e lançamento `OPENING` se houver saldo inicial |
| `GET` | `/wallets/:walletId` | Consultar carteira |
| `GET` | `/wallets/:walletId/ledger?limit=50&cursor=...` | Ledger paginado com cursor |
| `POST` | `/wallets/:walletId/reconciliation` | Confrontar saldo armazenado com ledger |
| `POST` | `/wagering/transactions` | Receber operação de provedor com `Idempotency-Key` |
| `GET` | `/wagering/transactions/:transactionId` | Consultar transação por UUID |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar por provedor + identificador externo |
| `GET` | `/health/live` | Liveness do processo |
| `GET` | `/health/ready` | Readiness de PostgreSQL e SQS |
| `GET` | `/metrics` | Métricas textuais Prometheus; uso interno |

A rota histórica `POST /wager-transactions` é mantida para compatibilidade; novas integrações devem preferir `/wagering/transactions`.

### Exemplo: criar carteira

```http
POST /wallets
Content-Type: application/json

{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Use o `id` da carteira retornada na operação abaixo:

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-001

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-001",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<UUID retornado ao criar a carteira>",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

A submissão pode retornar HTTP **202** com `RECEIVED` enquanto o processamento é assíncrono. Consulte a transação posteriormente; status interno `APPLIED` é exposto como `PROCESSED` nos endpoints do provedor. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. Valores monetários usam **strings decimais de duas casas**, não `number`.

## Qualidade e testes

```powershell
bun run build
bun run test
bun run test:e2e
bun run lint
```

**Última execução local informada (16/10/2026):** build aprovado; **146/146 testes unitários** em 21 arquivos; **1/1 teste E2E**; **zero erros e avisos no Oxlint**. O E2E automatizado existente verifica somente `GET /` e não deve ser apresentado como cobertura de PostgreSQL + SQS.

Foram executadas verificações manuais com containers reais para: rollback/refund fora de ordem, worker de recuperação e expiração, Inbox + redelivery, publicação Outbox, eventos de domínio, concorrência de duas apostas contra uma carteira e métricas em duas instâncias.

**Caso de concorrência observado:** wallet com R$ 100,00, duas `BET` de R$ 80,00; uma `PROCESSED`, outra `REJECTED` por `INSUFFICIENT_FUNDS`, saldo final **R$ 20,00**, **um débito** e reconciliação com diferença zero. Reentregas posteriores mantiveram esses invariantes.

Os testes de integração com PostgreSQL e LocalStack foram executados manualmente durante o desenvolvimento. Os scripts auxiliares específicos desse ambiente não acompanham o repositório. O script versionado `scripts/provision-sqs.mjs` permite provisionar as filas FIFO e suas respectivas DLQs. A automatização completa dos testes de integração em um ambiente isolado permanece como melhoria futura.

## Observabilidade e operação

- `/health/live`: indica que o processo HTTP está ativo; independe da infraestrutura.
- `/health/ready`: verifica PostgreSQL e ambas as filas SQS configuradas; retorna HTTP 503 se alguma falhar.
- `/metrics`: consulta gauges em PostgreSQL/SQS e contadores locais do processo; retorna HTTP 503 quando não consegue realizar um scrape consistente.
- Métricas locais **reiniciam** com cada processo. Scrapeie cada instância individualmente; não interprete valores locais como totais globais.
- Monitore `jungle_outbox_oldest_unpublished_age_seconds`, estados `DEAD`, DLQ, transações rejeitadas e divergências de reconciliação.

**Não exponha `/metrics` nem os endpoints financeiros publicamente sem controles de rede/autorização.** Este exercício não integra um provedor OIDC; consulte a decisão em `ARCHITECTURE.md`.

## Limitações e próximos passos

- Cobertura de integração automatizada com PostgreSQL/LocalStack ainda incompleta; os cenários críticos foram exercitados por scripts locais.
- Não há evidência automatizada consolidada de três processos simultâneos, queda após commit/antes de ACK e dois publishers disputando a mesma Outbox em um teste de CI.
- O shutdown executa hooks do NestJS; a garantia sob carga e durante operações pendentes ainda deve ser demonstrada.
- A autenticação/autorização foi conscientemente deixada fora do escopo de implementação; é necessária antes de exposição externa.
- A reversibilidade de algumas migrations com dados preenchidos exige intervenção/validação: não prometa rollback destrutivo automático.

## Referências internas

- [ARCHITECTURE.md](./ARCHITECTURE.md) — decisões, concorrência, idempotência, erros e limitações.
- [README-DESAFIO.md](./README-DESAFIO.md) — enunciado original; preservar sem alterações.
