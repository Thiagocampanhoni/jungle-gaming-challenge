# Revisão antes do primeiro commit

O comando `git status --short` mostrou arquivos `??` não rastreados. Isso **não** indica erro no código; indica que, no estado apresentado, ainda não foram adicionados ao índice do Git.

## Não versionar automaticamente

- `.env`, `.env.*` com segredos (a única exceção intencional deve ser `.env.example` com credenciais **fictícias de desenvolvimento**).
- `node_modules/`, `dist/`, `coverage/`.
- `.financial-concurrency-results/`, `.sqs-*.json` e outros resultados locais de execução.
- `README.zip`, pacotes `*.zip`, backups, artefatos temporários e dados financeiros de teste exportados.
- Logs, caches e arquivos `.pem`, `.p12`, `.key`, `*.sqlite` que não pertençam ao código-fonte.

> **Não substituir `.gitignore` sem ler a versão existente.** A primeira ação é inspecionar o arquivo, corrigir suas regras e verificar `git status --short` novamente. Nunca use `git add -f` para burlar exclusões de segredos.

## Candidatos a versionar

`.env.example` higienizado, `.gitignore`, `.gitattributes`, `bun.lock`, configurações de TypeScript/Vitest/Oxlint/Nest, `package.json`, `compose.yaml`, `mikro-orm.config.ts`, `src/`, `test/`, `scripts/` reutilizáveis, `README.md`, `ARCHITECTURE.md` e `README-DESAFIO.md` se a licença e as orientações do processo seletivo permitirem compartilhar o enunciado no repositório.

Arquivos `LEIA-ME_PATCH_*.md`, diretórios `jungle-event-contract-audit/` e `outbox-controlled-publication/` devem ser revisados caso a caso. A documentação de uma entrega final costuma ficar mais legível com um README principal e uma arquitetura, em vez de acumular notas de patches.

## Comandos de conferência (somente leitura)

```powershell
git status --short
Get-Content .gitignore

git check-ignore -v -- .env .financial-concurrency-results/ .sqs-05-pending.json README.zip

Get-ChildItem -Force -File | Select-Object Name
```

O `git check-ignore` retorna status não-zero caso não encontre correspondência; isso serve para identificar regras ainda ausentes.

## Preparação segura

Depois de conferir os arquivos e o `.gitignore`, **adicione pastas/arquivos explicitamente** ou use `git add -n .` como simulação. Faça `git diff --cached --stat` e `git diff --cached --name-only` para confirmar o conteúdo do commit. Busque nomes de arquivo suspeitos e credenciais antes de `git commit`.

Não publicar URL de banco real, tokens AWS, senhas, dumps SQL, dados pessoais de usuários ou mensagens de produção. Para prova técnica, prefira um repositório privado e siga a política de submissão da empresa.
