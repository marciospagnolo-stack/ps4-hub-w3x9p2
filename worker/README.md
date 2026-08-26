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

`GET /conversao` devolve a taxa de conversão do **mês corrente** nos dois funis,
já com a metodologia auditada aplicada (denominador A+B+C, componente D fora,
janela 16→15 no B2B, coorte pura e só aquisição no B2C):

```json
{
  "gerado_em": "2026-08-26T15:45:00.000Z",
  "mes": "2026-08", "dia_do_mes": 26, "dias_no_mes": 31,
  "b2b": {
    "metodo": "janela_16_15",
    "janela": { "de": "2026-07-16", "ate": "2026-08-15" },
    "janela_fechada": true,
    "canais": { "Inbound": [241, 27], "Farmer": [289, 46], "Palestrante": [16, 1] },
    "total": [546, 74], "receita": 812345.67, "vendas_projetadas": 89
  },
  "b2c": { "metodo": "coorte", "produtos": { "TBW Weekend": [203,14], "Best Day+": [18,1] }, "total": [221,15] },
  "receita_b2c": { "TBW Weekend": [30,341200], "Best Day+": [8,14900], "expansao": [24,151300] },
  "origens_nao_mapeadas": []
}
```

Cada par é `[propostas, vendas]` — ou `[vendas, receita]` em `receita_b2c`.
`vendas_projetadas` é extrapolação linear pelos dias decorridos e vem `null`
enquanto a janela do denominador estiver aberta (dia ≤ 15). `origens_nao_mapeadas`
lista valores de `origem_da_qualificacao`/`origem_do_lead` que não caíram em
nenhum canal — se encher, o mapeamento em `src/conversao.js` ficou defasado.

O Cron Trigger (`*/15 * * * *`) recalcula e grava no KV; o endpoint só lê o KV,
então nenhuma visita paga a espera do HubSpot. Se o KV estiver frio (cron parado
há mais de uma hora), o endpoint recalcula em vez de servir número velho calado.
`?refresh=1` força o recálculo.

Por que 15 minutos e não tempo real: o ciclo mediano é de 15 dias no B2B e 8 no
B2C, e `closedate` é editável e entra com atraso. Atualizar mais rápido só
mostraria ruído de coorte imatura.

Quem consome: `conversao.html` na raiz do repo. Os meses fechados continuam
vindo dos CSVs versionados em `dados/conversao/` — o endpoint cobre apenas o mês
corrente, que é a única parte que ainda se move.

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

# KV do agregado de conversão — crie uma vez e cole o id em wrangler.toml
wrangler kv namespace create CONVERSAO_KV

wrangler deploy
```

Depois do deploy, cole a URL do Worker na constante `PSA_WORKER_URL` no topo de
`conversao.js` (na raiz do repo) e faça commit. Enquanto ela estiver vazia, a
página serve só os números auditados dos CSVs e diz isso no cabeçalho.

Pra conferir o endpoint antes de ligar na página:

```bash
curl -s https://psa-curadoria.SUA-CONTA.workers.dev/conversao | jq
```

Saída do `deploy` mostra a URL do Worker, algo como
`https://psa-curadoria.<sua-conta>.workers.dev`.

Cole essa URL em `curadoria.html`, na constante `PSA_WORKER_URL` no topo
do `<script>`. Commit, push. Pronto.

## Permissões do Private App do HubSpot

O token precisa dos escopos:
- `crm.objects.deals.read`  (também usado pelo `/conversao`)
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
