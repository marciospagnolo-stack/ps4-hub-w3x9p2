# Funil de conversão · B2B e B2C · Profissionais SA

Reconstrução da taxa de conversão dos dois funis a partir do HubSpot (portal `49656171`),
com dados até **26/08/2026**.

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `config.json` | IDs de pipeline e etapa, propriedades, regras de classificação, armadilhas conhecidas |
| `queries.sql` | Todas as consultas usadas, comentadas e prontas para reexecução |
| `b2b_mensal.csv` | Propostas, vendas e taxa por mês e canal |
| `b2c_mensal.csv` | Propostas, vendas e taxa por mês e produto de aquisição |
| `b2c_receita.csv` | Vendas, receita e ticket por frente, incluindo a expansão que fica fora da conversão |

## Resultado

| | Acumulado jan–ago | Ciclo mediano | Método |
|---|---|---|---|
| **B2B** | **15,1%** — 479 vendas / 3.181 propostas | 15,1 dias | coorte até maio, janela 16→15 depois |
| **B2C aquisição** | **10,7%** — 211 vendas / 1.971 propostas | 8,0 dias | coorte pura |

Agosto no B2B: 13,6% observado, **16,3% projetado** (denominador fechado, faltam as vendas de 27 a 31/08).
Agosto no B2C ainda é imaturo — a coorte tem ~12 dias e faltam cerca de 14% das decisões.

## Os quatro erros corrigidos

1. **IDs internos trocados no B2B.** A etapa "Proposta enviada" tem o ID `closedwon` e "Em negociação"
   tem `closedlost`. Qualquer relatório via API que filtre por `closedwon` conta proposta como venda.
2. **Etapa de ganho errada.** "Negócio fechado" é a etapa marcada como *closed won*; "Ganho / Contrato
   assinado" é administrativa e posterior. Usar só a segunda daria 11 vendas em agosto no lugar de 74.
3. **Denominador incompleto.** Um terço dos ganhos B2B não registra passagem pela proposta. Sem imputar
   a data pela etapa seguinte, a taxa mediria 12,9% em vez de 15,1%.
4. **Viés de só-ganhos.** Negócios criados e fechados sem passar por etapa nenhuma entravam na conta
   apenas quando eram ganhos — os perdidos sem rastro nunca foram registrados. Foram removidos dos dois
   funis. No B2C isso valia 3 pontos percentuais.

## Como o denominador é montado

```
denominador = A + B + C
  A  negócio TEM carimbo de "Proposta enviada"        → usa a data real
  B  não tem A, mas TEM "Em negociação"               → imputa a data desse carimbo
  C  não tem A nem B, mas TEM "Negociação avançada"   → imputa a data desse carimbo (só B2B)
  D  ganho sem carimbo nenhum                          → EXCLUÍDO
```

Perdidos sem rastro também ficam fora: 895 no B2B, 3.425 no B2C. Não dá para distinguir
"perdeu depois da proposta" de "perdeu antes dela". **Este é o maior risco residual** — se todos
tivessem tido proposta, o B2B cairia para cerca de 12%.

## Por que métodos diferentes nos dois funis

O B2B tem ciclo longo e disperso: mediana de 15 dias, mas só 49% fecham nesse prazo (p75 = 34, p90 = 58).
A janela defasada 16→15 embute exatamente essa mediana e funciona para meses ainda abertos.

O B2C tem ciclo curto e concentrado: mediana de 8 dias, 74% em 15 e 86% em 30. A coorte amadurece
sozinha em um mês, então não precisa de janela — e usar a do B2B jogaria metade das propostas para
o balde errado.

## O que fica fora do B2C

A conversão B2C cobre **apenas aquisição** (TBW Weekend e Best Day/Start/Weeks). A expansão —
Legacy, Ecossistema, PSA, Mentorias — é venda para quem já é cliente, quase sempre criada direto
como ganha: **230 vendas e R$ 1,16 mi, 28% da receita**. Somar as duas produzia uma taxa que subia
quando crescia a recompra, não quando o funil melhorava.

## Leitura dos resultados

**B2B.** O Inbound caiu de 20% em fevereiro para 10% em março e ficou seis meses nesse patamar —
é um degrau, não uma tendência. Com 1.590 propostas no ano, cada ponto vale ~16 vendas. O Farmer
converte 18,2% contra 11,0% do Inbound e passou de 31% para 53% do mix; a taxa total só não caiu
mais porque o peso migrou para o canal melhor.

**B2C.** Existe um teto aparente perto de 200 propostas/mês: nos meses de volume baixo (abril e maio)
a conversão foi 17,0% e 15,4%; nos de volume alto ficou entre 8% e 11%. TBW e Best Day convertem
igual (10,4% e 11,6%) — a diferença é só o ticket, R$ 10,3k contra R$ 2,0k.

## Próximos cortes

- **B2B:** Inbound de fevereiro contra março, por campanha, fonte de tráfego ou dono. É onde deve
  estar a explicação do degrau.
- **B2C:** quantos compradores de Best Day compram TBW depois. Decide se o produto é porta de entrada
  ou dispersão de capacidade comercial.

## Armadilhas do ambiente

- `produto_de_interesse` é **multi-seleção**. Filtro `IN` faz correspondência parcial e devolve
  resultado errado sem erro. Sempre agrupar e classificar fora do banco.
- A reporting API aceita no máximo **2 dimensões** em `GROUP BY` — a terceira é descartada em silêncio.
- `hs_v2_date_entered_1076664460` teve 412 entradas em fev/26 por migração em massa. Não serve como
  data de ganho; usar `closedate`.
- `closedate` é editável e registros entram com atraso. Travar o mês só na primeira semana do
  mês seguinte.
