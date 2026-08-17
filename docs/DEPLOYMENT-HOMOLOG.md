# Deploy de homologação — ai-api

1. Criar um repositório Git separado para este conteúdo e publicar a branch que
   contém `Dockerfile` e `render.yaml`.
2. No Render, criar um Blueprint apontando para esse repositório.
3. Preencher `AI_WEB_ORIGIN` com a URL do `ai-web` no Vercel.
4. Preencher `UMMIX_SERVICE_TOKEN`, `AI_HANDOFF_ENCRYPTION_KEY` e
   `OPENAI_API_KEY` como secrets.
5. Manter `CAMPAIGN_CONTENT_ENABLED=false` na primeira publicação.
6. Confirmar `GET /health` e `GET /ready` antes de conectar o `ai-web`.

O PostgreSQL definido no Blueprint é temporário e privado. Não deve receber
dados de produção nem ser tratado como banco definitivo.
