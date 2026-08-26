// Cálculo ao vivo da taxa de conversão do mês corrente (B2B + B2C).
//
// Replica exatamente a metodologia auditada em dados/conversao/README.md:
//   denominador = A + B + C   (A = carimbo real de "Proposta enviada";
//                              B = sem A, mas com "Em negociação";
//                              C = sem A nem B, mas com "Negociação avançada" — só B2B)
//   D (ganho sem carimbo nenhum) fica FORA dos dois lados da conta.
//   B2B: janela defasada 16 do mês anterior → 15 do mês atual; vendas por closedate no mês.
//   B2C: coorte pura da proposta, só produtos de aquisição.
//
// Os meses fechados continuam vindo dos CSVs versionados. Este módulo cobre
// apenas o mês corrente, que é a única parte que ainda se move.

const TZ_MS = 3 * 3600e3; // portal opera em BRT (UTC-3)

export const PIPE = { b2b: 'default', b2c: '725182862' };

const ETAPA = {
  b2b: {
    proposta:  'hs_v2_date_entered_closedwon',   // "Proposta enviada | 1° Follow"
    negoc:     'hs_v2_date_entered_closedlost',  // "Em negociação"
    avancada:  'hs_v2_date_entered_1167445770',
    ganho:     ['1076664462', '1076664460'],
  },
  b2c: {
    proposta:  'hs_v2_date_entered_1057266722',
    negoc:     'hs_v2_date_entered_1275670104',
    avancada:  null,
    ganho:     ['1105295876'],
  },
};

const PROPS_B2B = ['dealstage', 'closedate', 'amount', 'origem_da_qualificacao', 'origem_do_lead',
  'esse_negocio_e_de_kam_', ETAPA.b2b.proposta, ETAPA.b2b.negoc, ETAPA.b2b.avancada];
const PROPS_B2C = ['dealstage', 'closedate', 'amount', 'produto_de_interesse',
  ETAPA.b2c.proposta, ETAPA.b2c.negoc];

/* ---------- datas em BRT ---------- */
const diaBRT = (y, m, d) => Date.UTC(y, m - 1, d) + TZ_MS;
const fimDiaBRT = (y, m, d) => diaBRT(y, m, d) + 24 * 3600e3 - 1;
const diasNoMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function hojeBRT(agora) {
  const d = new Date(agora - TZ_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/* ---------- classificação ---------- */
const CANAL_B2B = {
  Inbound:     ['inbound', 'indicação', 'indicacao', 'indicação partner | b2b'],
  Farmer:      ['farmer', 'kam', 'cadência do bdr', 'cadencia do bdr', 'curador', 'carteira do farmer'],
  Palestrante: ['palestrante', 'base de palestrantes', 'agência de palestrantes', 'agencia de palestrantes'],
};

export function canalB2B(p, drift) {
  const bruto = (p.origem_da_qualificacao || '').trim() || (p.origem_do_lead || '').trim();
  if (!bruto) return 'Inbound';
  // "Ação de CRM" só vira Farmer quando o negócio é de carteira.
  if (/^a[çc][ãa]o de crm/i.test(bruto)) {
    if (/carteira/i.test(bruto)) return 'Farmer';
    return /^sim/i.test((p.esse_negocio_e_de_kam_ || '').trim()) ? 'Farmer' : 'Inbound';
  }
  const v = bruto.toLowerCase();
  for (const [canal, chaves] of Object.entries(CANAL_B2B)) {
    if (chaves.some(k => v === k || v.startsWith(k))) return canal;
  }
  if (drift) drift.add(bruto); // não silencia o que não mapeou
  return 'Inbound';
}

const GRUPO_B2C = [
  ['TBW Weekend', ['tbw weekend (presencial)', 'não se aplica', 'nao se aplica']],
  ['Best Day+',   ['pré the best weekend', 'pre the best weekend', 'amolador',
                   'tbw weeks (online)', 'the best weeks (pré lançamento)', 'the best weeks (pre lancamento)']],
  ['Mentorias',   ['caleidoscópio', 'caleidoscopio', 'story_making', 'mentoria márcio', 'mentoria marcio']],
  ['Base',        ['legacy', 'ecossistema', 'psa partner', 'psa.experience', 'drops',
                   'clara (tokens)', 'leopoldo (tokens)']],
];

// produto_de_interesse é MULTI-SELEÇÃO: 'TBW Weekend;Legacy' conta como aquisição.
export function grupoB2C(valor) {
  const tokens = String(valor || '').split(';').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return 'TBW Weekend'; // vazio cai em aquisição, conforme config.json
  for (const [grupo, chaves] of GRUPO_B2C) {
    if (tokens.some(t => chaves.includes(t))) return grupo;
  }
  return 'Base'; // valor desconhecido: trata como expansão, fora da conta de conversão
}
const EH_AQUISICAO = g => g === 'TBW Weekend' || g === 'Best Day+';

/* ---------- acesso ao HubSpot ---------- */
async function busca(token, body, hs) {
  const out = [];
  let after;
  do {
    const r = await hs('/crm/v3/objects/deals/search', token, {
      method: 'POST',
      body: JSON.stringify(after ? { ...body, after } : body),
    });
    out.push(...(r.results || []));
    after = r.paging?.next?.after;
    if (after) await new Promise(r2 => setTimeout(r2, 220)); // search API: ~5 req/s
  } while (after && out.length < 10000);
  return out;
}

const entre = (prop, de, ate) => ({ propertyName: prop, operator: 'BETWEEN', value: String(de), highValue: String(ate) });
const igual = (prop, v) => ({ propertyName: prop, operator: 'EQ', value: v });

/* Denominador A+B+C de um funil dentro de uma janela de datas. */
async function propostas(token, hs, funil, de, ate, props) {
  const e = ETAPA[funil];
  const carimbos = [e.proposta, e.negoc, e.avancada].filter(Boolean);
  const vistos = new Map();

  for (const carimbo of carimbos) {
    const anteriores = carimbos.slice(0, carimbos.indexOf(carimbo));
    const lote = await busca(token, {
      filterGroups: [{ filters: [igual('pipeline', PIPE[funil]), entre(carimbo, de, ate)] }],
      properties: props,
      limit: 100,
    }, hs);
    for (const d of lote) {
      if (vistos.has(d.id)) continue;
      // componente B/C só valem quando os carimbos anteriores estão VAZIOS
      if (anteriores.some(a => d.properties?.[a])) continue;
      vistos.set(d.id, d.properties || {});
    }
  }
  return [...vistos.values()];
}

/* Ganhos por closedate no mês.
   excluirD=true remove os "só-ganhos" sem carimbo nenhum — obrigatório na conta de
   conversão, mas NÃO na de receita, onde esses negócios faturaram de verdade. */
async function ganhosNoMes(token, hs, funil, de, ate, props, excluirD = true) {
  const e = ETAPA[funil];
  const carimbos = [e.proposta, e.negoc, e.avancada].filter(Boolean);
  const lote = await busca(token, {
    filterGroups: e.ganho.map(st => ({
      filters: [igual('pipeline', PIPE[funil]), igual('dealstage', st), entre('closedate', de, ate)],
    })),
    properties: props,
    limit: 100,
  }, hs);
  const vistos = new Map();
  for (const d of lote) {
    const p = d.properties || {};
    if (excluirD && !carimbos.some(c => p[c])) continue;
    vistos.set(d.id, p);
  }
  return [...vistos.values()];
}

/* ---------- cálculo do mês corrente ---------- */
export async function calcularMesCorrente(token, hs, agora = Date.now()) {
  const { y, m, d } = hojeBRT(agora);
  const mesIni = diaBRT(y, m, 1);
  const mesFim = fimDiaBRT(y, m, diasNoMes(y, m));
  const nDias = diasNoMes(y, m);
  const drift = new Set();

  /* --- B2B: janela defasada 16 → 15 --- */
  const antY = m === 1 ? y - 1 : y, antM = m === 1 ? 12 : m - 1;
  const janIni = diaBRT(antY, antM, 16);
  const janFim = fimDiaBRT(y, m, 15);
  const janelaFechada = agora > janFim;

  const propB2B = await propostas(token, hs, 'b2b', janIni, janFim, PROPS_B2B);
  const ganhoB2B = await ganhosNoMes(token, hs, 'b2b', mesIni, mesFim, PROPS_B2B);

  const canais = { Inbound: [0, 0], Farmer: [0, 0], Palestrante: [0, 0] };
  for (const p of propB2B) canais[canalB2B(p, drift)][0]++;
  for (const p of ganhoB2B) canais[canalB2B(p, drift)][1]++;
  const receitaB2B = ganhoB2B.reduce((a, p) => a + (parseFloat(p.amount) || 0), 0);

  /* --- B2C: coorte pura do mês, só aquisição --- */
  const propB2C = await propostas(token, hs, 'b2c', mesIni, mesFim, PROPS_B2C);
  const produtos = { 'TBW Weekend': [0, 0], 'Best Day+': [0, 0] };
  for (const p of propB2C) {
    const g = grupoB2C(p.produto_de_interesse);
    if (!EH_AQUISICAO(g)) continue; // expansão fica fora da conta
    produtos[g][0]++;
    if (ETAPA.b2c.ganho.includes(p.dealstage)) produtos[g][1]++;
  }

  /* --- Receita B2C do mês, por frente (inclui expansão, que fica fora da conversão) --- */
  const recB2C = await ganhosNoMes(token, hs, 'b2c', mesIni, mesFim, PROPS_B2C, false);
  const receita = { 'TBW Weekend': [0, 0], 'Best Day+': [0, 0], expansao: [0, 0] };
  for (const p of recB2C) {
    const g = grupoB2C(p.produto_de_interesse);
    const chave = EH_AQUISICAO(g) ? g : 'expansao';
    receita[chave][0]++;
    receita[chave][1] += parseFloat(p.amount) || 0;
  }

  const somar = o => Object.values(o).reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
  const totalB2B = somar(canais);
  const totalB2C = somar(produtos);

  // Projeção do B2B: extrapolação linear das vendas pelos dias decorridos do mês.
  // Só faz sentido com a janela do denominador já fechada.
  const projB2B = (janelaFechada && d < nDias && totalB2B[1] > 0)
    ? Math.round(totalB2B[1] * nDias / d) : null;

  return {
    gerado_em: new Date(agora).toISOString(),
    mes: `${y}-${String(m).padStart(2, '0')}`,
    dia_do_mes: d,
    dias_no_mes: nDias,
    b2b: {
      metodo: 'janela_16_15',
      janela: { de: new Date(janIni).toISOString().slice(0, 10), ate: new Date(janFim).toISOString().slice(0, 10) },
      janela_fechada: janelaFechada,
      canais, total: totalB2B, receita: receitaB2B,
      vendas_projetadas: projB2B,
    },
    b2c: {
      metodo: 'coorte',
      coorte_madura: false, // a coorte do mês corrente sempre tem decisões pendentes
      produtos, total: totalB2C,
    },
    receita_b2c: receita,
    origens_nao_mapeadas: [...drift].slice(0, 20),
  };
}
