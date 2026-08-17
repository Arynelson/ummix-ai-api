# Ummix AI API

API independente dos módulos `campaign-assistant` e `campaign-content` da Ummix.
Este repositório é implantado no Render e não acessa o banco principal: toda
integração com `services` ocorre por HTTP autenticado.

## Desenvolvimento

Pré-requisitos: Node.js 22, npm e PostgreSQL 16.

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run db:migrate
npm.cmd run dev
```

Verificação:

```powershell
npm.cmd test
npm.cmd run build
```

## Deploy no Render

O `render.yaml` cria a API e um PostgreSQL temporário privado para homologação.
Os secrets marcados com `sync: false` devem ser preenchidos no painel do Render.
O serviço executa as migrations antes de iniciar a API.

A API utiliza `UMMIX_API_URL=https://ummix.workingtech.com.br/api` e mantém o
`UMMIX_SERVICE_TOKEN` somente no ambiente do servidor. O frontend nunca recebe
esse token.

Por segurança, `CAMPAIGN_CONTENT_ENABLED=false` e o envio de e-mail permanecem
desligados até o adapter correspondente em `services` e os testes de homologação
serem concluídos.

## Contratos

`contracts/` é uma cópia versionada dos contratos públicos compartilhados com o
`ai-web`. Versão atual: `0.1.0`. Qualquer alteração nesse diretório deve ser
replicada no repositório `ai-web` e registrada no manifesto central do workspace.
