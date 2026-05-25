# PSA Curadoria Worker

Backend mínimo para a tela `curadoria.html` puxar dados do HubSpot sem expor
token no navegador. Roda em Cloudflare Workers (grátis até 100k req/dia).

## O que faz hoje

`POST /curadoria` recebe `{ "dealId": "12345678901" }` e devolve:

```json
{
  "deal":        { "name", "amount", "closedate", "stage", "description", "pipeline" },
  "company":     { "name", "industry", "city", "state", ... },
  "contact":     { "firstname", "lastname", "jobtitle", "email", "phone" },
  "notes":       [ { "id", "body", "createdate" }, ... ],      // até 30 — inclui WhatsApp colado
  "meetingLinks":[ "https://drive.google.com/...", ... ]       // detectados nas notas
}
```

A página classifica esse JSON nos 16 campos com o mesmo classificador
de transcrição que já está rodando.

## O que ainda *não* faz (TODO)

- **Baixar transcrição do Drive/Zoom**: os links são extraídos das notas e
  retornados em `meetingLinks`, mas o conteúdo ainda não é baixado.
  Próxima fase: service account Google Drive + Zoom Cloud Recordings API.
- **Sumarização via LLM**: hoje o classificador no navegador é regex.
  Trocar por chamada à Claude API daria saltos de qualidade — basta adicionar
  `ANTHROPIC_API_KEY` como secret e um endpoint `/curadoria/summarize`.

## Deploy (uma vez)

```bash
cd worker
npm install -g wrangler
wrangler login
wrangler secret put HUBSPOT_TOKEN     # cole o pat-... do Private App
wrangler deploy
```

Saída do `deploy` mostra a URL do Worker, algo como
`https://psa-curadoria.<sua-conta>.workers.dev`.

Cole essa URL em `curadoria.html`, na constante `PSA_WORKER_URL` no topo
do `<script>`. Commit, push. Pronto.

## Permissões do Private App do HubSpot

O token precisa dos escopos:
- `crm.objects.deals.read`
- `crm.objects.contacts.read`
- `crm.objects.companies.read`
- `crm.objects.notes.read`

## CORS

Edite `wrangler.toml` → `ALLOWED_ORIGINS` para incluir seu domínio do
GitHub Pages e qualquer host local que use pra desenvolver.

## Teste local

```bash
wrangler dev
# em outro terminal:
curl -X POST http://localhost:8787/curadoria \
  -H "Content-Type: application/json" \
  -d '{"dealId":"SEU_ID_AQUI"}' | jq
```

## Custo esperado

Cloudflare Workers free tier: 100.000 requisições/dia, 10ms CPU por
request. Esse endpoint faz ~5 chamadas HTTP serializadas ao HubSpot por
deal, então fica dentro do CPU budget tranquilo. Custo previsto: **R$ 0**.
