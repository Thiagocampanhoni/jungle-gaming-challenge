# Architecture Decision Record — Jungle Gaming

## 1. Objetivos e limites

Este serviço recebe operações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` de múltiplos provedores. Deve preservar o saldo e a rastreabilidade financeira quando requisições e mensagens chegam duplicadas, fora de ordem ou simultaneamente. **PostgreSQL é a fonte de verdade**; a entrega do SQS é tratada como *at-least-once*.

**Escopo documentado:** código consolidado até Patch 07D e resultados locais reportados em 16/10/2026. As evidências distinguem testes unitários de cenários manuais com serviços reais; funcionalidades não verificadas exaustivamente não são declaradas infalíveis.

## 2. Componentes e responsabilidades

| Componente | Responsabilidade |
|---|---|
| `Money` | Aritmética monetária com centavos em `bigint`, validação e serialização decimal |
| `Wallet` / `WalletService` | Criar carteira; saldo + versão; `OPENING`; leitura do ledger e reconciliação |
| `WagerTransactionIntakeService` | Validar contrato de negócio, idempotência e persistir operação recebida |
| `WagerTransactionProcessor` | Executar regras financeiras em transação SQL, serializando alterações da wallet |
| `InboxMessage` | Proteger processamento SQS por `(consumer_name, message_id)` |
| `OutboxMessage` / `OutboxPublisherService` | Publicação confiável posterior ao commit com claim concorrente |
| `WagerTransactionConsumerService` | Long polling SQS, processamento, ACK após commit e retry/DLQ |
| `PendingReferenceRecoveryService` | Retomar referências ausentes com agenda persistida e rejeição terminal |
| `HealthController` / `MetricsController` | Liveness, readiness e métricas operacionais |

Infraestrutura local: NestJS/TypeScript no Bun; MikroORM/PostgreSQL 17; filas SQS FIFO no LocalStack; Docker Compose; testes Vitest.

## 3. Precisão monetária e ledger

- Quantias são interpretadas com `Money` e representadas em centavos por `bigint`; JSON usa decimal de duas casas como string (`"80.00"`).
- PostgreSQL usa `NUMERIC(19,2)` para saldo e valores financeiros; não se usa ponto flutuante binário para calcular dinheiro.
- `BET`: débito, exigindo saldo suficiente. `WIN`: crédito. `LOSS`: nenhum movimento financeiro. `REFUND`: crédito correspondente à `BET` referenciada. `ROLLBACK`: movimento inverso da referência permitida.
- `REFUND`/`ROLLBACK` referenciam operações por identidade do provedor; verificações incluem carteira, jogador, moeda, rodada, tipo e valor, além de proteção contra reversão repetida.
- Uma rejeição de negócio não grava lançamento financeiro. O banco impõe restrições de saldo não negativo e proteções de imutabilidade do ledger.
- A criação de carteira com saldo inicial positivo grava uma transação interna `OPENING` e um crédito de ledger no mesmo commit.
- Reconciliação compara o saldo materializado com os movimentos de débito/crédito; **não corrige divergências silenciosamente**.

## 4. Consistência transacional e concorrência

**Unidade de concorrência: wallet.** O processador obtém locks SQL `FOR UPDATE` sobre as linhas relevantes e aplica saldo, versão, ledger, estado da transação e eventos Outbox dentro da mesma transação do PostgreSQL. Transações sobre a mesma carteira são serializadas pelo banco, mesmo com mais de um processo NestJS. Não confiamos apenas em `MessageGroupId` ou em FIFO para manter a correção.

O processamento de uma operação recebida externamente pelo SQS também incorpora o registro de Inbox na transação. O ACK SQS ocorre **depois** do commit. O crash após commit/antes do ACK pode gerar nova entrega; ela precisa ser resolvida como repetição, sem novo débito.

**Evidência observada:** dois processos independentes disputaram R$ 100,00 com duas apostas de R$ 80,00. Resultado: um débito de R$ 80,00, saldo R$ 20,00, outra aposta rejeitada e diferença zero no ledger. Cenários com ≥3 workers e wallets distintas precisam ser consolidados em testes de integração automatizados.

## 5. Idempotência de negócio e de transporte

Há proteções complementares:

1. **HTTP/provedor:** `Idempotency-Key` obrigatório no contrato `/wagering/transactions`; unicidades no PostgreSQL por provedor e identidade externa, com `payload_hash` determinístico (SHA-256 de projeção ordenada dos campos de negócio). Replay idêntico reutiliza a transação; payload conflitante resulta em conflito.
2. **SQS/Inbox:** unicidade por `(consumer_name, message_id)`; hash e transação são conferidos em redeliveries, permitindo ACK seguro sem reaplicação.
3. **Outbox/eventos:** chave determinística baseada em transação, tipo e versão do evento; publicação pode ser repetida após falha, então consumidores externos também devem ser idempotentes.

A rota histórica `/wager-transactions` permanece para compatibilidade, mas novos clientes devem adotar o contrato por provedor.

## 6. SQS FIFO, Outbox e falhas

A configuração usa **duas filas FIFO distintas**: comandos (`SQS_QUEUE_URL`) e eventos (`SQS_EVENTS_QUEUE_URL`), cada uma com sua DLQ FIFO. O script `scripts/provision-sqs.mjs` cria uma fila e sua DLQ por execução, com `maxReceiveCount = 5`. A Outbox usa `MessageGroupId` associado à wallet na publicação FIFO.

O publisher seleciona lotes de mensagens com `FOR UPDATE SKIP LOCKED`, claim transacional e lease (`locked_at`, expiração de 60 s). Após a publicação, marca `PUBLISHED`; em falhas, registra tentativa, reagendamento exponencial e finalmente `DEAD` após atingir a política configurada (limite operacional de 8 tentativas). Mensagens `DEAD` exigem análise/recuperação operacional; não são consideradas publicadas.

O consumer faz long polling, decide ACK ou retry, e só elimina a mensagem após resultado confirmado no PostgreSQL. Erros transitórios sofrem alteração de visibilidade/backoff; mensagens problemáticas podem chegar à DLQ de comandos. O SQS não executa transações atômicas com PostgreSQL: o desenho é *at-least-once + idempotência*, não *exactly-once delivery*.

Eventos versionados são instâncias de subclasses de `IntegrationEvent<T>`: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference`. O envelope carrega `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt`, `version` e `data`; `causationId` é opcional.

## 7. Referências fora de ordem

Uma reversão cuja referência ainda não esteja disponível entra em `PENDING_REFERENCE`. A tabela `pending_reference_jobs` mantém tentativas, agenda e vencimento. O worker é opt-in (`PENDING_REFERENCE_WORKER_ENABLED=true`), usa transações e locks com `SKIP LOCKED`, reprocessa com backoff limitado e encerra com rejeição auditável se a referência expirar ou exceder tentativas.

Implementação conhecida: polling a cada **1 segundo**, **até 20 tentativas** e expiração programada em **24 horas** no registro/migration de compatibilidade. O código calcula a próxima tentativa com backoff limitado. Rejeições terminais incluem `REFERENCE_EXPIRED` e `REFERENCE_RETRY_EXHAUSTED`, com evento Outbox correspondente. Como o estado é persistido, a recuperação pode continuar mesmo após redrive da mensagem original para DLQ.

## 8. API e fronteiras de acesso

Os endpoints se dividem em: criação/consulta de wallet e ledger, submissão/consulta de transações, reconciliação, health e métricas. Respostas de provedor expõem `PROCESSED` para status interno `APPLIED`; estados intermediários e rejeições são preservados. Valores monetários são strings, códigos de falha são estáveis e identificadores são consultados de forma parametrizada.

**Autenticação não implementada:** decisão consciente, pois o enunciado não atribui pontos a autenticação; health precisa permanecer público ao orquestrador. Antes de exposição real, incluir autenticação por Identity Provider externo (OIDC/JWT), autorização por `providerId`, controles de rede e rate limiting. Não confiar em `providerId` enviado pelo cliente sem vincular a uma identidade autenticada. `/metrics` deve permanecer acessível apenas à infraestrutura interna. Em ambiente real, limitar acesso também às APIs financeiras de leitura/escrita.

## 9. Observabilidade e shutdown

- `GET /health/live` verifica se o processo responde.
- `GET /health/ready` consulta PostgreSQL e ambas as filas configuradas; indisponibilidade gera HTTP 503.
- `GET /metrics` serve texto Prometheus se todas as fontes forem consultáveis; falha gera HTTP 503 em JSON, preservando o `Content-Type` do erro (Patch 07D).
- Métricas de estados são gauges agregadas a partir do PostgreSQL; contagens de SQS/DLQ são aproximadas; contadores de ACKs, retries, duplicatas e latência do consumer são **locais a cada instância** e reiniciam no restart.
- `app.enableShutdownHooks()` aciona hooks de desligamento; os loops de consumer e publisher aguardam encerramento. **O teste de shutdown durante operação financeira em andamento ainda precisa de cobertura específica.**
- Scrapes SQL de latência medem também espera em fila; o contador de locks cobre erros explícitos, não toda contenção normal.

## 10. Limitações e riscos residuais

| Tema | Situação |
|---|---|
| Testes unitários | 146/146 aprovados no Windows (16/10/2026) |
| E2E automatizado | 1 teste: `GET /`; **não** cobre os fluxos financeiros reais |
| Testes reais manuais | PostgreSQL, LocalStack, concorrência de duas apostas, redelivery, DLQ/recovery, Outbox e métricas testados isoladamente |
| Teste 3 instâncias | Ainda não documentado como integração automatizada repetível |
| Dois publishers concorrentes | Lógica de claim analisada; falta teste de integração automatizado consolidado |
| Crash após commit e antes de ACK | Proteção arquitetural presente; cenário controlado automatizado ainda pendente |
| Shutdown sob carga | Não demonstrado integralmente |
| Segurança de produção | Sem autenticação/identidade de provedor; requer IdP, autorização e controles de rede |
| Migrations reversíveis | Backfills/proteções podem impossibilitar rollback direto com dados persistidos; validar antes de usar `migration:down` |
| Outbox `DEAD` / DLQ | Necessita procedimento operacional de inspeção, intervenção e replay idempotente |

A prioridade restante é automatizar integrações em containers limpos (migrations, Inbox/Outbox atômicas, cenário de duas apostas, ≥3 processos, dois publishers, falha entre commit e ACK, DLQ/recovery) e criar um fluxo de CI para executar essas verificações com isolamento de dados.

## 11. Referências

- `README.md`: preparação, contratos e comandos.
- `README-DESAFIO.md`: enunciado técnico original.
- `src/database/migrations/`: schema e constraints versionadas.
- `scripts/`: provisionamento e diagnósticos; conferir dependências em dados locais antes da reutilização.
