# Relatório de Gestão — Funil B2B / Leitura dos Closers

Contexto de projeto para o Claude Code continuar de onde a conversa no Claude.ai parou.
O entregável é um painel/relatório do funil B2B do HubSpot, visto pela "temperatura"
que cada closer atribui aos negócios.

## Objetivo
Relatório dos negócios **ativos até a etapa Negociação avançada**, segmentados pela
leitura do closer (campo Temperatura Atual), com cortes por etapa, por closer e por
valor (R$). Público: gestão comercial. Perguntas centrais:
- Quanto do funil ativo cada closer está bancando vs. largando?
- Quanto ainda está sem leitura, em que etapas e de quem?
- Qual o valor (R$) em jogo por etiqueta?

## HubSpot — estrutura (descoberta na conversa, já validada)
- Account ID: `49656171` · Moeda: BRL · Fuso: America/Sao_Paulo
- Pipeline alvo: **"Funil de Vendas B2B"** → `pipeline = "default"`

### Etapas ATIVAS até Negociação avançada (o recorte do relatório)
Atenção: duas etapas reaproveitam os IDs internos de fechamento do HubSpot, mas os
negócios continuam ABERTOS (`hs_is_closed = false`). Não confie no nome do ID.

| dealstage (id interno)   | rótulo no funil                 |
|--------------------------|---------------------------------|
| `presentationscheduled`  | Conexão                         |
| `decisionmakerboughtin`  | Reunião agendada / Qualificado  |
| `contractsent`           | Aguardando Envio de Proposta    |
| `closedwon`              | Proposta enviada  (ABERTO!)     |
| `closedlost`             | Em negociação     (ABERTO!)     |
| `1167445770`             | Negociação avançada             |

### Etapas terminais (fora do recorte ativo)
`1076664462` Negócio fechado · `1076664460` Ganho / Contrato assinado ·
`1367665802` Resting · `1076664461` Perdido (concentra ~90% do pipeline histórico).

### Campo da leitura do closer
`temperatura_atual` (enumeration). Valores internos → rótulo:
- `Vou vender`      → Vou vender (banca a venda)
- `Café com leite`  → Café com leite (sem firmeza, nova chance)
- `Não levo fé`     → **Larguei de mão** (sugere troca de jogador)  ← rótulo difere do valor interno!

Negócios sem esse campo = "sem leitura" (usar operador `NOT_HAS_PROPERTY`).

### Valor
`amount_in_home_currency` (já convertido para BRL). Somar este campo para valor por etiqueta/closer.

### Closers que preenchem temperatura (owner id → nome)
80454586 Rafael Teixeira · 92704130 Talita Santos Cruz · 80169395 Lucas Oliveira ·
80454588 João Gabriel Marins Pereira · 86859895 Mateus Mariano ·
80651489 Catarina Varoni Borges · 87159365 João Lucas Backmann ·
92333469 Rafael Oliveira Alves · 94316538 Gabriel Oliveira Alves.
(Negócios sem leitura pertencem a esses + vários SDRs/vendedores; resolver nomes via owners.)

## Gotchas importantes (aprendidos na marra)
1. **Dados mudam em tempo real.** A cobertura da leitura foi de 19% → 71% em ~1 dia.
   Todo número é um SNAPSHOT; carimbe data/hora. Não costure cortes de consultas tiradas
   em momentos diferentes — não fecham entre si.
2. **A busca do HubSpot não agrega (sem SUM/COUNT/GROUP BY).** Para valor em R$ e cross-tabs
   consistentes: OU habilitar o escopo "Query portal data" (reporting) e usar SQL do conector,
   OU — melhor no Claude Code — puxar TODOS os negócios ativos uma vez (paginado) e agregar em código.
   Isso dá um retrato único e consistente, com contagens, somas e cruzamentos.
3. Existe um registro de teste no funil: "TESTE LÓE (NÃO EXCLUIR)" (~R$ 24.101) — excluir dos números.

## Como buscar os dados
- Opção A (recomendada): conectar o MCP do HubSpot no Claude Code
  (`claude mcp add hubspot --transport http <url-do-mcp-hubspot>`), depois pedir para
  puxar todos os deals ativos e agregar em código.
- Opção B: HubSpot REST API — `POST /crm/v3/objects/deals/search` com filtro
  `pipeline = default` + `dealstage IN [as 6 etapas ativas]`, paginando por `after`.
  Propriedades: dealname, dealstage, temperatura_atual, amount_in_home_currency, hubspot_owner_id.

## Entregável atual
`funil-b2b-closers.html` — painel estático (dark, tema "temperatura"). Seções: KPIs de
cobertura, termômetro do funil, 3 cartões de etiqueta, trajetória da cobertura, volumetria
total por status. Próximas camadas a construir: valor (R$) por etiqueta, cruzamento
etiqueta × closer, e uma "lista de trabalho" dos sem-leitura (priorizando os avançados).

## Próximo passo sugerido no Claude Code
Escrever um script (Python) que: puxa todos os ativos até Neg. avançada, agrega por
etiqueta/etapa/closer + soma R$, e regenera o HTML — rodável a qualquer momento para
um snapshot fresco e consistente.
