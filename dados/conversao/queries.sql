-- =====================================================================
-- Funil de conversão · Profissionais SA · HubSpot portal 49656171
-- Dialeto: HubSpot query_crm_data (SQL restrito)
-- Sem JOIN, sem CTE, sem subquery, sem CASE, sem HAVING, sem alias AS.
-- GROUP BY aceita no MÁXIMO 2 dimensões — a terceira é descartada em silêncio.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. DESCOBERTA — rodar primeiro se o portal mudar
-- ---------------------------------------------------------------------

-- 0.1 Quais etapas existem e qual é a de ganho de verdade
SELECT dealstage, hs_is_closed_won, COUNT(*)
FROM DEAL WHERE pipeline = 'default'
GROUP BY dealstage, hs_is_closed_won;
-- Resultado esperado B2B: só 1076664462 ("Negócio fechado") tem hs_is_closed_won = true.
-- 1076664460 ("Ganho / Contrato assinado") é etapa administrativa POSTERIOR.


-- ---------------------------------------------------------------------
-- 1. B2B — DENOMINADOR
-- ---------------------------------------------------------------------

-- 1.A Propostas com carimbo real (componente A)
SELECT DATE_TRUNC(hs_v2_date_entered_closedwon, 'DAY'), COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND hs_v2_date_entered_closedwon BETWEEN '2025-12-16' AND '2026-08-16'
GROUP BY DATE_TRUNC(hs_v2_date_entered_closedwon, 'DAY')
ORDER BY DATE_TRUNC(hs_v2_date_entered_closedwon, 'DAY') ASC;

-- 1.B Sem carimbo de proposta, mas passou por "Em negociação" (componente B)
--     A data de entrada em Em negociação vira o proxy da proposta.
SELECT DATE_TRUNC(hs_v2_date_entered_closedlost, 'DAY'), COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND hs_v2_date_entered_closedwon IS NULL
  AND hs_v2_date_entered_closedlost BETWEEN '2026-05-10' AND '2026-08-20'
GROUP BY DATE_TRUNC(hs_v2_date_entered_closedlost, 'DAY')
ORDER BY DATE_TRUNC(hs_v2_date_entered_closedlost, 'DAY') ASC;

-- 1.C Sem os dois, mas passou por "Negociação avançada" (componente C)
SELECT DATE_TRUNC(hs_v2_date_entered_1167445770, 'DAY'), COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND hs_v2_date_entered_closedwon IS NULL
  AND hs_v2_date_entered_closedlost IS NULL
  AND hs_v2_date_entered_1167445770 BETWEEN '2026-05-10' AND '2026-08-20'
GROUP BY DATE_TRUNC(hs_v2_date_entered_1167445770, 'DAY')
ORDER BY DATE_TRUNC(hs_v2_date_entered_1167445770, 'DAY') ASC;

-- 1.D EXCLUÍDO da conta — ganhos que nunca passaram por etapa alguma.
--     Rodar apenas para AUDITAR o tamanho do viés (eram 31 no B2B).
SELECT DATE_TRUNC(closedate, 'MONTH'), COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND dealstage IN ('1076664462', '1076664460')
  AND hs_v2_date_entered_closedwon IS NULL
  AND hs_v2_date_entered_closedlost IS NULL
  AND hs_v2_date_entered_1167445770 IS NULL
  AND closedate BETWEEN '2026-01-01' AND '2026-08-27'
GROUP BY DATE_TRUNC(closedate, 'MONTH');


-- ---------------------------------------------------------------------
-- 2. B2B — NUMERADOR
-- ---------------------------------------------------------------------

-- 2.1 Coorte (jan–mai): desfecho das propostas de cada mês
SELECT DATE_TRUNC(hs_v2_date_entered_closedwon, 'MONTH'), dealstage, COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND hs_v2_date_entered_closedwon BETWEEN '2026-01-01' AND '2026-05-31'
GROUP BY DATE_TRUNC(hs_v2_date_entered_closedwon, 'MONTH'), dealstage;

-- 2.2 Janela (jun–ago): ganhos pelo mês de fechamento
SELECT DATE_TRUNC(closedate, 'MONTH'), COUNT(*), SUM(amount_in_home_currency)
FROM DEAL
WHERE pipeline = 'default'
  AND dealstage IN ('1076664462', '1076664460')
  AND closedate BETWEEN '2026-01-01' AND '2026-08-27'
GROUP BY DATE_TRUNC(closedate, 'MONTH');

-- 2.3 Janela de propostas de UM mês específico (repetir trocando as datas)
--     Jun: 2026-05-16 a 2026-06-15 | Jul: 06-16 a 07-15 | Ago: 07-16 a 08-15
SELECT origem_da_qualificacao, COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND hs_v2_date_entered_closedwon BETWEEN '2026-07-16' AND '2026-08-15'
GROUP BY origem_da_qualificacao;


-- ---------------------------------------------------------------------
-- 3. B2B — CANAL
-- ---------------------------------------------------------------------

-- 3.1 Canal primário por coorte
SELECT DATE_TRUNC(hs_v2_date_entered_closedwon, 'MONTH'), origem_da_qualificacao, COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND hs_v2_date_entered_closedwon BETWEEN '2026-01-01' AND '2026-05-31'
GROUP BY DATE_TRUNC(hs_v2_date_entered_closedwon, 'MONTH'), origem_da_qualificacao;

-- 3.2 Fallback: quando origem_da_qualificacao está vazia, usar origem_do_lead
SELECT DATE_TRUNC(hs_v2_date_entered_closedwon, 'MONTH'), origem_do_lead, COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND origem_da_qualificacao IS NULL
  AND hs_v2_date_entered_closedwon BETWEEN '2026-01-01' AND '2026-05-31'
GROUP BY DATE_TRUNC(hs_v2_date_entered_closedwon, 'MONTH'), origem_do_lead;

-- 3.3 Ação de CRM: separar carteira de não-carteira
SELECT DATE_TRUNC(hs_v2_date_entered_closedwon, 'MONTH'), esse_negocio_e_de_kam_, COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND origem_da_qualificacao = 'Ação de CRM'
  AND hs_v2_date_entered_closedwon BETWEEN '2026-01-01' AND '2026-05-31'
GROUP BY DATE_TRUNC(hs_v2_date_entered_closedwon, 'MONTH'), esse_negocio_e_de_kam_;
-- 'Sim, através de reunião' e 'Sim, através de outro canal' -> Farmer
-- 'Não', 'Não, veio de inbound' e vazio -> Inbound


-- ---------------------------------------------------------------------
-- 4. B2C — COORTE POR PRODUTO
-- ---------------------------------------------------------------------

-- 4.1 Denominador A: propostas com carimbo, por produto
SELECT DATE_TRUNC(hs_v2_date_entered_1057266722, 'MONTH'), produto_de_interesse, COUNT(*)
FROM DEAL
WHERE pipeline = '725182862'
  AND hs_v2_date_entered_1057266722 BETWEEN '2026-01-01' AND '2026-08-31'
GROUP BY DATE_TRUNC(hs_v2_date_entered_1057266722, 'MONTH'), produto_de_interesse
LIMIT 300;

-- 4.2 Numerador A: quantas dessas viraram ganho
SELECT DATE_TRUNC(hs_v2_date_entered_1057266722, 'MONTH'), produto_de_interesse, COUNT(*)
FROM DEAL
WHERE pipeline = '725182862'
  AND dealstage = '1105295876'
  AND hs_v2_date_entered_1057266722 BETWEEN '2026-01-01' AND '2026-08-31'
GROUP BY DATE_TRUNC(hs_v2_date_entered_1057266722, 'MONTH'), produto_de_interesse
LIMIT 300;

-- 4.3 Denominador B: sem carimbo de proposta, com "Em negociação"
SELECT DATE_TRUNC(hs_v2_date_entered_1275670104, 'MONTH'), produto_de_interesse, COUNT(*)
FROM DEAL
WHERE pipeline = '725182862'
  AND hs_v2_date_entered_1057266722 IS NULL
  AND hs_v2_date_entered_1275670104 BETWEEN '2026-01-01' AND '2026-08-31'
GROUP BY DATE_TRUNC(hs_v2_date_entered_1275670104, 'MONTH'), produto_de_interesse
LIMIT 300;

-- 4.4 Numerador B
SELECT DATE_TRUNC(hs_v2_date_entered_1275670104, 'MONTH'), produto_de_interesse, COUNT(*)
FROM DEAL
WHERE pipeline = '725182862'
  AND dealstage = '1105295876'
  AND hs_v2_date_entered_1057266722 IS NULL
  AND hs_v2_date_entered_1275670104 BETWEEN '2026-01-01' AND '2026-08-31'
GROUP BY DATE_TRUNC(hs_v2_date_entered_1275670104, 'MONTH'), produto_de_interesse
LIMIT 300;

-- 4.5 Receita e ticket por produto e mês
SELECT DATE_TRUNC(closedate, 'MONTH'), produto_de_interesse, COUNT(*), SUM(amount_in_home_currency)
FROM DEAL
WHERE pipeline = '725182862'
  AND dealstage = '1105295876'
  AND closedate BETWEEN '2026-01-01' AND '2026-08-27'
GROUP BY DATE_TRUNC(closedate, 'MONTH'), produto_de_interesse
LIMIT 500;
-- NÃO usar: WHERE produto_de_interesse IN ('TBW Weekend (Presencial)', ...)
-- O IN faz correspondência PARCIAL nesses valores e devolve linhas erradas em silêncio.
-- Sempre trazer todos os produtos e classificar no código.


-- ---------------------------------------------------------------------
-- 5. CICLO — extrair pares de data e calcular a mediana fora do banco
-- ---------------------------------------------------------------------

-- 5.1 B2B
SELECT hs_object_id, closedate, hs_v2_date_entered_closedwon
FROM DEAL
WHERE pipeline = 'default'
  AND dealstage IN ('1076664462', '1076664460')
  AND closedate BETWEEN '2026-01-01' AND '2026-08-26'
LIMIT 500;

-- 5.2 B2C
SELECT hs_object_id, closedate, hs_v2_date_entered_1057266722, produto_de_interesse
FROM DEAL
WHERE pipeline = '725182862'
  AND dealstage = '1105295876'
  AND hs_v2_date_entered_1057266722 IS NOT NULL
  AND closedate BETWEEN '2026-01-01' AND '2026-08-27'
LIMIT 200;


-- ---------------------------------------------------------------------
-- 6. AUDITORIA — perdidos sem rastro (ficam fora, mas medir o risco)
-- ---------------------------------------------------------------------
SELECT dealstage, COUNT(*)
FROM DEAL
WHERE pipeline = 'default'
  AND hs_v2_date_entered_closedwon IS NULL
  AND hs_v2_date_entered_closedlost IS NULL
  AND hs_v2_date_entered_1167445770 IS NULL
  AND hs_v2_date_entered_1076664462 IS NULL
  AND closedate BETWEEN '2026-01-01' AND '2026-08-27'
GROUP BY dealstage;
-- B2B: 895 perdidos. B2C (trocando pipeline e propriedades): 3.425.
-- Se todos tivessem tido proposta, o B2B cairia de 15,1% para ~12%.
