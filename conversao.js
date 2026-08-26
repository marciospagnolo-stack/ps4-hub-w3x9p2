/* Taxa de Conversão — B2B e B2C · PSA
   Dados: dados/conversao/*.csv (HubSpot portal 49656171, extração 26/08/2026).
   Mantidos inline para a página abrir sem depender de fetch/CORS no GitHub Pages.
   Ao atualizar os CSVs, atualize os arrays abaixo na mesma ordem. */

const MESES = ['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];
const ROTULO = ['jan','fev','mar','abr','mai','jun','jul','ago'];

// b2b_mensal.csv — [propostas, vendas] por mês
const B2B = {
  metodo:      ['coorte','coorte','coorte','coorte','coorte','janela_16_15','janela_16_15','janela_16_15'],
  Inbound:     [[231,25],[177,36],[225,23],[157,15],[180,17],[199,18],[180,14],[241,27]],
  Farmer:      [[116,22],[131,22],[183,37],[190,33],[161,24],[166,33],[211,47],[289,46]],
  Palestrante: [[23,6],  [25,5],  [23,2],  [23,8],  [12,5],  [9,6],   [13,7],  [16,1]],
  TOTAL:       [[370,53],[333,63],[431,62],[370,56],[353,46],[374,57],[404,68],[546,74]],
};

// b2c_mensal.csv — [propostas, vendas] por mês (só aquisição)
const B2C = {
  'TBW Weekend': [[279,33],[250,19],[195,17],[127,20],[125,19],[120,13],[191,20],[203,14]],
  'Best Day+':   [[47,0],  [22,4],  [112,12],[61,12], [63,10], [61,4],  [97,13], [18,1]],
  TOTAL:         [[326,33],[272,23],[307,29],[188,32],[188,29],[181,17],[288,33],[221,15]],
};

// b2c_receita.csv — [vendas, receita_brl] por mês
const RECEITA = {
  'TBW Weekend': { tipo:'aquisicao', d:[[48,484120],[34,259020],[26,273120],[33,334510],[36,409000],[34,354500],[34,386000],[27,308520]] },
  'Best Day+':   { tipo:'aquisicao', d:[[1,997],[1,1080],[17,42394],[28,55644],[16,28455],[12,20576],[17,39170],[7,12792]] },
  'Mentorias':   { tipo:'expansao',  d:[[1,7000],[6,45000],[4,60000],[5,62500],[5,51500],[6,74000],[7,104000],[0,0]] },
  'Base':        { tipo:'expansao',  d:[[0,0],[17,43028],[28,84701],[36,120464],[34,96000],[37,181900],[23,98125],[21,133100]] },
};

// README: agosto com denominador fechado, faltando as vendas de 27 a 31/08.
// Sobrescrito pela leitura ao vivo quando o Worker responde.
let B2B_VENDAS_PROJETADAS = 89;

// Expansão (Mentorias + Base) só aparece somada na tela — mantida como array próprio
// para a hidratação ao vivo poder reescrevê-la sem tocar na quebra por produto.
const EXPANSAO = {
  vendas:  MESES.map((_, i) => RECEITA['Mentorias'].d[i][0] + RECEITA['Base'].d[i][0]),
  receita: MESES.map((_, i) => RECEITA['Mentorias'].d[i][1] + RECEITA['Base'].d[i][1]),
};

// Endpoint do Worker que devolve o mês corrente ao vivo. Mesmo Worker que o
// curadoria.html já usa. Enquanto a versão com /conversao não estiver publicada,
// a chamada dá 404 e a página segue nos números auditados dos CSVs, dizendo isso
// no cabeçalho. Vazio desliga a leitura ao vivo de vez.
const PSA_WORKER_URL = 'https://psa-curadoria.marcio-spagnolo.workers.dev';
const INTERVALO_REFRESH_MS = 5 * 60 * 1000;

/* ---------- formatação ---------- */
const nf  = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = v => nf1.format(v) + '%';
const int = v => nf.format(v);
const taxa = ([p, v]) => (p ? v / p * 100 : 0);
const soma = arr => arr.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
function brl(v, curto) {
  if (curto) {
    if (Math.abs(v) >= 1e6) return 'R$ ' + nf1.format(v / 1e6) + ' mi';
    if (Math.abs(v) >= 1e3) return 'R$ ' + nf.format(Math.round(v / 1e3)) + 'k';
  }
  return 'R$ ' + nf.format(Math.round(v));
}
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- helpers de eixo ---------- */
function escalaY(max) {
  const passos = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1e3, 2e3, 2.5e3, 5e3, 1e4, 2e4, 2.5e4, 5e4, 1e5, 2e5, 2.5e5, 5e5, 1e6];
  for (const p of passos) {
    const n = Math.ceil(max / p);
    if (n <= 6) return { max: n * p, passo: p, n };
  }
  const p = passos[passos.length - 1];
  const n = Math.ceil(max / p);
  return { max: n * p, passo: p, n };
}

/* ---------- infraestrutura de render + tooltip ---------- */
const registro = [];
function grafico(sel, desenha) {
  const host = document.querySelector(sel);
  if (!host) return;
  const tip = host.querySelector('.tip');
  const render = () => {
    const w = Math.max(280, host.clientWidth);
    const { svg, alvos } = desenha(w);
    const antigo = host.querySelector('svg');
    if (antigo) antigo.remove();
    host.insertAdjacentHTML('afterbegin', svg);
    ligaTooltip(host, tip, alvos);
  };
  registro.push(render);
  render();
}

function ligaTooltip(host, tip, alvos) {
  if (!tip || !alvos || !alvos.length) return;
  const svg = host.querySelector('svg');
  const escala = () => svg.getBoundingClientRect().width / parseFloat(svg.dataset.w);
  const marca = (i) => {
    svg.querySelectorAll('[data-hl]').forEach(el => { el.style.opacity = el.dataset.hl === String(i) ? '1' : '0'; });
  };
  const mostra = (ev) => {
    const r = svg.getBoundingClientRect();
    const k = escala();
    const x = (ev.clientX - r.left) / k;
    let melhor = alvos[0], dist = Infinity;
    for (const a of alvos) { const d = Math.abs(a.x - x); if (d < dist) { dist = d; melhor = a; } }
    tip.innerHTML = melhor.html;
    tip.style.opacity = '1';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let px = melhor.x * k + 14;
    if (px + tw > r.width) px = melhor.x * k - tw - 14;
    tip.style.left = Math.max(0, px) + 'px';
    tip.style.top = Math.max(0, Math.min((melhor.y ?? 40) * k - th / 2, r.height - th)) + 'px';
    marca(melhor.i);
  };
  svg.addEventListener('mousemove', mostra);
  svg.addEventListener('mouseleave', () => { tip.style.opacity = '0'; marca(-1); });
  svg.addEventListener('touchstart', e => { if (e.touches[0]) mostra(e.touches[0]); }, { passive: true });
  svg.addEventListener('touchmove', e => { if (e.touches[0]) mostra(e.touches[0]); }, { passive: true });
}

function legenda(sel, itens) {
  const el = document.querySelector(sel);
  if (el) el.innerHTML = itens.map(i => i.anel
    ? `<span><i class="swatch" style="background:transparent;border:2px solid ${i.cor};border-radius:50%"></i>${esc(i.nome)}</span>`
    : `<span><i class="swatch" style="background:${i.cor}"></i>${esc(i.nome)}</span>`).join('');
}

function tabela(sel, cabecalho, linhas, totais) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.innerHTML = '<table><thead><tr>' + cabecalho.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>'
    + linhas.map(l => '<tr>' + l.map(c => `<td>${c}</td>`).join('') + '</tr>').join('')
    + (totais ? '<tr class="tot">' + totais.map(c => `<td>${c}</td>`).join('') + '</tr>' : '')
    + '</tbody></table>';
}

/* ---------- gráfico de linhas ---------- */
function linhas({ w, series, rotulos, yMax, yFmt, tipFmt, alturaBase = 300 }) {
  const h = Math.max(220, Math.min(alturaBase, w * 0.52));
  const maiorNome = Math.max(...series.map(se => se.nome.length));
  const ml = 46, mt = 14, mb = 28;
  const mr = Math.min(Math.max(60, 22 + maiorNome * 7.6), w * 0.4);
  const iw = w - ml - mr, ih = h - mt - mb;
  const escY = escalaY(yMax);
  const X = i => ml + (rotulos.length === 1 ? iw / 2 : iw * i / (rotulos.length - 1));
  const Y = v => mt + ih - (v / escY.max) * ih;

  let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" data-w="${w}" role="img">`;
  for (let g = 0; g <= escY.n; g++) {
    const v = g * escY.passo, y = Y(v);
    s += `<line x1="${ml}" y1="${y.toFixed(1)}" x2="${ml + iw}" y2="${y.toFixed(1)}" stroke="${g ? css('--grid') : css('--axis')}" stroke-width="1"/>`;
    s += `<text x="${ml - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${css('--muted')}" font-family="system-ui,sans-serif">${yFmt(v)}</text>`;
  }
  rotulos.forEach((r, i) => {
    s += `<text x="${X(i).toFixed(1)}" y="${h - 8}" text-anchor="middle" font-size="11" fill="${css('--muted')}" font-family="system-ui,sans-serif">${esc(r)}</text>`;
  });
  // crosshair
  rotulos.forEach((_, i) => {
    s += `<line data-hl="${i}" x1="${X(i).toFixed(1)}" y1="${mt}" x2="${X(i).toFixed(1)}" y2="${mt + ih}" stroke="${css('--axis')}" stroke-width="1" opacity="0"/>`;
  });
  const fins = [];
  for (const se of series) {
    const d = se.dados.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    s += `<path d="${d}" fill="none" stroke="${se.cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (se.tracejado) {
      const a = se.tracejado; // [iDe, valorDe, iPara, valorPara]
      s += `<path d="M${X(a[0]).toFixed(1)},${Y(a[1]).toFixed(1)} L${X(a[2]).toFixed(1)},${Y(a[3]).toFixed(1)}" fill="none" stroke="${se.cor}" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round"/>`;
      s += `<circle cx="${X(a[2]).toFixed(1)}" cy="${Y(a[3]).toFixed(1)}" r="4" fill="${css('--surface')}" stroke="${se.cor}" stroke-width="2"/>`;
    }
    se.dados.forEach((v, i) => {
      s += `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4" fill="${se.cor}" stroke="${css('--surface')}" stroke-width="2"/>`;
    });
    const ul = se.dados.length - 1;
    fins.push({ y: Y(se.dados[ul]), texto: se.nome });
  }
  // afasta rótulos de fim que ficariam sobrepostos
  fins.sort((a, b) => a.y - b.y);
  for (let i = 1; i < fins.length; i++) {
    if (fins[i].y - fins[i - 1].y < 15) fins[i].y = fins[i - 1].y + 15;
  }
  const excesso = fins.length ? fins[fins.length - 1].y - (mt + ih) : 0;
  if (excesso > 0) fins.forEach(f => { f.y -= excesso; });
  for (const f of fins) {
    s += `<text x="${(X(rotulos.length - 1) + 10).toFixed(1)}" y="${(f.y + 4).toFixed(1)}" font-size="11.5" font-weight="600" fill="${css('--ink-2')}" font-family="system-ui,sans-serif">${esc(f.texto)}</text>`;
  }
  s += '</svg>';

  const alvos = rotulos.map((r, i) => ({
    i, x: X(i), y: Y(Math.max(...series.map(se => se.dados[i]))),
    html: `<div class="t-h">${esc(r)}</div>` + series.map(se =>
      `<div class="t-r"><span class="t-n"><i class="swatch" style="background:${se.cor}"></i>${esc(se.nome)}</span><b>${tipFmt(se, i)}</b></div>`).join(''),
  }));
  return { svg: s, alvos };
}

/* ---------- barras empilhadas ---------- */
function empilhadas({ w, series, rotulos, normalizar, yFmt, tipFmt, alturaBase = 300 }) {
  const h = Math.max(220, Math.min(alturaBase, w * 0.62));
  const ml = 52, mr = 12, mt = 14, mb = 28;
  const iw = w - ml - mr, ih = h - mt - mb;
  const n = rotulos.length;
  const passoX = iw / n, bw = Math.min(46, passoX * 0.62);
  const totais = rotulos.map((_, i) => series.reduce((a, se) => a + se.dados[i], 0));
  const escY = normalizar ? { max: 100, passo: 25, n: 4 } : escalaY(Math.max(...totais));
  const X = i => ml + passoX * i + (passoX - bw) / 2;
  const Y = v => mt + ih - (v / escY.max) * ih;

  let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" data-w="${w}" role="img">`;
  for (let g = 0; g <= escY.n; g++) {
    const v = g * escY.passo, y = Y(v);
    s += `<line x1="${ml}" y1="${y.toFixed(1)}" x2="${ml + iw}" y2="${y.toFixed(1)}" stroke="${g ? css('--grid') : css('--axis')}" stroke-width="1"/>`;
    s += `<text x="${ml - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${css('--muted')}" font-family="system-ui,sans-serif">${yFmt(v)}</text>`;
  }
  rotulos.forEach((r, i) => {
    s += `<text x="${(X(i) + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle" font-size="11" fill="${css('--muted')}" font-family="system-ui,sans-serif">${esc(r)}</text>`;
  });
  for (let i = 0; i < n; i++) {
    let base = 0;
    const total = totais[i] || 1;
    series.forEach((se, k) => {
      const v = normalizar ? se.dados[i] / total * 100 : se.dados[i];
      if (v <= 0) { base += v; return; }
      const y0 = Y(base + v), y1 = Y(base);
      const gap = k === series.length - 1 ? 0 : 2;      // 2px de respiro entre segmentos
      const alt = Math.max(1, y1 - y0 - gap);
      const topo = k === series.length - 1 ? 4 : 0;      // ponta arredondada só no fim do dado
      s += `<path d="${retanguloTopo(X(i), y0, bw, alt, topo)}" fill="${se.cor}"/>`;
      if (alt > 17 && bw > 26) {
        s += `<text x="${(X(i) + bw / 2).toFixed(1)}" y="${(y0 + alt / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#ffffff" font-family="system-ui,sans-serif">${normalizar ? Math.round(v) + '%' : ''}</text>`;
      }
      base += v;
    });
    s += `<rect data-hl="${i}" x="${(X(i) - 3).toFixed(1)}" y="${mt}" width="${bw + 6}" height="${ih}" fill="${css('--ink')}" opacity="0" style="opacity:0"/>`;
  }
  s += '</svg>';

  const alvos = rotulos.map((r, i) => ({
    i, x: X(i) + bw / 2, y: Y(totais[i]),
    html: `<div class="t-h">${esc(r)}</div>` + series.map(se =>
      `<div class="t-r"><span class="t-n"><i class="swatch" style="background:${se.cor}"></i>${esc(se.nome)}</span><b>${tipFmt(se, i)}</b></div>`).join(''),
  }));
  return { svg: s, alvos };
}

function retanguloTopo(x, y, w, h, r) {
  if (!r) return `M${x},${y} h${w} v${h} h${-w} Z`;
  r = Math.min(r, h, w / 2);
  return `M${x},${y + r} a${r},${r} 0 0 1 ${r},${-r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} h${-w} Z`;
}

/* ---------- dispersão ---------- */
function dispersao({ w, pontos, cor, xFmt, yFmt, tipHtml, alturaBase = 300 }) {
  const h = Math.max(230, Math.min(alturaBase, w * 0.7));
  const ml = 46, mr = 22, mt = 16, mb = 40;
  const iw = w - ml - mr, ih = h - mt - mb;
  const xs = pontos.map(p => p.x), ys = pontos.map(p => p.y);
  const eX = escalaY(Math.max(...xs) * 1.06), eY = escalaY(Math.max(...ys) * 1.12);
  const X = v => ml + (v / eX.max) * iw;
  const Y = v => mt + ih - (v / eY.max) * ih;

  let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" data-w="${w}" role="img">`;
  for (let g = 0; g <= eY.n; g++) {
    const v = g * eY.passo, y = Y(v);
    s += `<line x1="${ml}" y1="${y.toFixed(1)}" x2="${ml + iw}" y2="${y.toFixed(1)}" stroke="${g ? css('--grid') : css('--axis')}" stroke-width="1"/>`;
    s += `<text x="${ml - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${css('--muted')}" font-family="system-ui,sans-serif">${yFmt(v)}</text>`;
  }
  for (let g = 1; g <= eX.n; g++) {
    const v = g * eX.passo, x = X(v);
    s += `<text x="${x.toFixed(1)}" y="${h - 22}" text-anchor="middle" font-size="11" fill="${css('--muted')}" font-family="system-ui,sans-serif">${xFmt(v)}</text>`;
  }
  s += `<text x="${(ml + iw / 2).toFixed(1)}" y="${h - 5}" text-anchor="middle" font-size="11" fill="${css('--muted')}" font-family="system-ui,sans-serif">propostas no mês</text>`;
  const postos = [];
  pontos.forEach(p => {
    const px = X(p.x), py = Y(p.y);
    // tenta acima; se colidir com um rótulo já posto, vai para baixo
    let ly = py - 11;
    const colide = y => postos.some(q => Math.abs(q.x - px) < 34 && Math.abs(q.y - y) < 13);
    if (colide(ly)) ly = py + 18;
    if (colide(ly)) ly = py - 11 - 14;
    postos.push({ x: px, y: ly });
    s += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="${cor}" stroke="${css('--surface')}" stroke-width="2"/>`;
    s += `<text x="${px.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="${css('--ink-2')}" font-family="system-ui,sans-serif">${esc(p.rot)}</text>`;
  });
  s += '</svg>';

  const alvos = pontos.map((p, i) => ({ i, x: X(p.x), y: Y(p.y), html: tipHtml(p) }));
  return { svg: s, alvos };
}

/* ================= montagem ================= */
const C1 = () => css('--s1'), C2 = () => css('--s2'), C3 = () => css('--s3');

function montar() {
  registro.length = 0; // remonta do zero: evita registrar o mesmo gráfico duas vezes

  const totB2B = soma(B2B.TOTAL), totB2C = soma(B2C.TOTAL);
  const ult = MESES.length - 1;

  /* KPIs */
  document.getElementById('k-b2b').textContent = pct(taxa(totB2B));
  document.getElementById('k-b2b-f').textContent = `${int(totB2B[1])} vendas / ${int(totB2B[0])} propostas`;
  document.getElementById('k-b2c').textContent = pct(taxa(totB2C));
  document.getElementById('k-b2c-f').textContent = `${int(totB2C[1])} vendas / ${int(totB2C[0])} propostas`;

  const obsB2B = taxa(B2B.TOTAL[ult]);
  // Sem denominador fechado não há projeção honesta: a janela ainda está recebendo propostas.
  const temProj = B2B_VENDAS_PROJETADAS != null && B2B_VENDAS_PROJETADAS > B2B.TOTAL[ult][1] && B2B.TOTAL[ult][0] > 0;
  const projB2B = temProj ? B2B_VENDAS_PROJETADAS / B2B.TOTAL[ult][0] * 100 : null;
  document.getElementById('k-mes').textContent = `${ROTULO[ult]} B2B`;
  document.getElementById('k-mes-v').innerHTML = temProj
    ? `${pct(obsB2B)} <span style="color:var(--muted);font-weight:400">→</span> ${pct(projB2B)}`
    : pct(obsB2B);
  document.getElementById('k-mes-f').textContent = temProj
    ? `observado (${B2B.TOTAL[ult][1]}/${B2B.TOTAL[ult][0]}) → projetado por extrapolação linear das vendas do mês`
    : `observado (${B2B.TOTAL[ult][1]}/${B2B.TOTAL[ult][0]}) · janela do denominador ainda aberta, sem projeção`;

  /* 1. série mensal */
  legenda('#lg-main', [{ nome: 'B2B', cor: C1() }, { nome: 'B2C aquisição', cor: C2() },
    ...(temProj ? [{ nome: `${ROTULO[ult]} B2B projetado (${pct(projB2B)})`, cor: C1(), anel: true }] : [])]);
  grafico('#c-main', w => linhas({
    w, rotulos: ROTULO, yMax: Math.max(22, (projB2B || 0) + 2), yFmt: v => v + '%',
    series: [
      { nome: 'B2B', cor: C1(), dados: B2B.TOTAL.map(taxa),
        ...(temProj ? { tracejado: [ult, obsB2B, ult, projB2B] } : {}) },
      { nome: 'B2C', cor: C2(), dados: B2C.TOTAL.map(taxa) },
    ],
    tipFmt: (se, i) => {
      const d = se.nome === 'B2B' ? B2B.TOTAL[i] : B2C.TOTAL[i];
      return `${pct(taxa(d))} <span style="color:var(--muted);font-weight:400">(${d[1]}/${d[0]})</span>`;
    },
  }));
  tabela('#t-main', ['Mês', 'B2B propostas', 'B2B vendas', 'B2B taxa', 'B2C propostas', 'B2C vendas', 'B2C taxa'],
    ROTULO.map((r, i) => [r, int(B2B.TOTAL[i][0]), int(B2B.TOTAL[i][1]), pct(taxa(B2B.TOTAL[i])),
      int(B2C.TOTAL[i][0]), int(B2C.TOTAL[i][1]), pct(taxa(B2C.TOTAL[i]))]),
    ['jan–' + ROTULO[ult], int(totB2B[0]), int(totB2B[1]), pct(taxa(totB2B)),
      int(totB2C[0]), int(totB2C[1]), pct(taxa(totB2C))]);

  /* 2. B2B por canal */
  const CANAIS = [
    { nome: 'Inbound', cor: C1(), d: B2B.Inbound },
    { nome: 'Farmer', cor: C2(), d: B2B.Farmer },
    { nome: 'Palestrante', cor: C3(), d: B2B.Palestrante },
  ];
  const CANAIS_LINHA = CANAIS.filter(c => c.nome !== 'Palestrante');
  legenda('#lg-b2bcanal', CANAIS_LINHA);
  legenda('#lg-b2bmix', CANAIS);
  grafico('#c-b2bcanal', w => linhas({
    w, rotulos: ROTULO, yMax: Math.max(...CANAIS_LINHA.flatMap(c => c.d.map(taxa))), yFmt: v => v + '%',
    series: CANAIS_LINHA.map(c => ({ nome: c.nome, cor: c.cor, dados: c.d.map(taxa) })),
    tipFmt: (se, i) => {
      const c = CANAIS.find(x => x.nome === se.nome).d[i];
      return `${pct(taxa(c))} <span style="color:var(--muted);font-weight:400">(${c[1]}/${c[0]})</span>`;
    },
  }));
  grafico('#c-b2bmix', w => empilhadas({
    w, rotulos: ROTULO, normalizar: true, yFmt: v => v + '%',
    series: CANAIS.map(c => ({ nome: c.nome, cor: c.cor, dados: c.d.map(x => x[0]) })),
    tipFmt: (se, i) => {
      const c = CANAIS.find(x => x.nome === se.nome).d[i];
      const t = CANAIS.reduce((a, x) => a + x.d[i][0], 0) || 1;
      return `${int(c[0])} <span style="color:var(--muted);font-weight:400">(${Math.round(c[0] / t * 100)}%)</span>`;
    },
  }));
  tabela('#t-b2bcanal', ['Mês', 'Método', 'Inbound', 'Farmer', 'Palestrante', 'Total'],
    ROTULO.map((r, i) => [r, B2B.metodo[i] === 'coorte' ? 'coorte' : 'janela 16→15',
      ...CANAIS.map(c => `${pct(taxa(c.d[i]))} (${c.d[i][1]}/${c.d[i][0]})`),
      `${pct(taxa(B2B.TOTAL[i]))} (${B2B.TOTAL[i][1]}/${B2B.TOTAL[i][0]})`]),
    ['jan–' + ROTULO[ult], '', ...['Inbound', 'Farmer', 'Palestrante'].map(k => {
      const t = soma(B2B[k]); return `${pct(taxa(t))} (${t[1]}/${t[0]})`;
    }), `${pct(taxa(totB2B))} (${totB2B[1]}/${totB2B[0]})`]);
  tabela('#t-b2bmix', ['Mês', 'Inbound', 'Farmer', 'Palestrante', 'Total propostas'],
    ROTULO.map((r, i) => {
      const t = CANAIS.reduce((a, x) => a + x.d[i][0], 0) || 1;
      return [r, ...CANAIS.map(c => `${int(c.d[i][0])} (${Math.round(c.d[i][0] / t * 100)}%)`), int(t)];
    }));

  const tInb = soma(B2B.Inbound), tFar = soma(B2B.Farmer), tPal = soma(B2B.Palestrante);
  document.getElementById('i-inb-prop').innerHTML = `<b>${int(tInb[0])}</b>`;
  document.getElementById('i-inb-taxa').innerHTML = `<b>${pct(taxa(tInb))}</b>`;
  document.getElementById('i-far-taxa').innerHTML = `<b>${pct(taxa(tFar))}</b>`;
  document.getElementById('i-pal').innerHTML = `<b>${int(tPal[0])}</b> propostas no ano e <b>${pct(taxa(tPal))}</b>`;

  /* 3. B2C */
  grafico('#c-b2cscatter', w => dispersao({
    w, cor: C2(), xFmt: v => int(v), yFmt: v => v + '%',
    pontos: ROTULO.map((r, i) => ({ rot: r, x: B2C.TOTAL[i][0], y: taxa(B2C.TOTAL[i]), i })),
    tipHtml: p => `<div class="t-h">${esc(p.rot)}</div>`
      + `<div class="t-r"><span class="t-n">propostas</span><b>${int(p.x)}</b></div>`
      + `<div class="t-r"><span class="t-n">vendas</span><b>${int(B2C.TOTAL[p.i][1])}</b></div>`
      + `<div class="t-r"><span class="t-n">taxa</span><b>${pct(p.y)}</b></div>`,
  }));
  tabela('#t-b2cscatter', ['Mês', 'Propostas', 'Vendas', 'Taxa'],
    ROTULO.map((r, i) => [r, int(B2C.TOTAL[i][0]), int(B2C.TOTAL[i][1]), pct(taxa(B2C.TOTAL[i]))]),
    ['jan–' + ROTULO[ult], int(totB2C[0]), int(totB2C[1]), pct(taxa(totB2C))]);

  const PRODUTOS = [
    { nome: 'TBW Weekend', cor: C1(), d: B2C['TBW Weekend'] },
    { nome: 'Best Day+', cor: C2(), d: B2C['Best Day+'] },
  ];
  legenda('#lg-b2cprod', PRODUTOS);
  grafico('#c-b2cprod', w => linhas({
    w, rotulos: ROTULO, yMax: Math.max(...PRODUTOS.flatMap(p => p.d.map(taxa))), yFmt: v => v + '%',
    series: PRODUTOS.map(p => ({ nome: p.nome, cor: p.cor, dados: p.d.map(taxa) })),
    tipFmt: (se, i) => {
      const d = PRODUTOS.find(x => x.nome === se.nome).d[i];
      return `${pct(taxa(d))} <span style="color:var(--muted);font-weight:400">(${d[1]}/${d[0]})</span>`;
    },
  }));
  tabela('#t-b2cprod', ['Mês', 'TBW Weekend', 'Best Day+', 'Total'],
    ROTULO.map((r, i) => [r, ...PRODUTOS.map(p => `${pct(taxa(p.d[i]))} (${p.d[i][1]}/${p.d[i][0]})`),
      `${pct(taxa(B2C.TOTAL[i]))} (${B2C.TOTAL[i][1]}/${B2C.TOTAL[i][0]})`]),
    ['jan–' + ROTULO[ult], ...['TBW Weekend', 'Best Day+', 'TOTAL'].map(k => {
      const t = soma(B2C[k]); return `${pct(taxa(t))} (${t[1]}/${t[0]})`;
    })]);

  const tTbw = soma(B2C['TBW Weekend']), tBd = soma(B2C['Best Day+']);
  const recTbw = RECEITA['TBW Weekend'].d.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
  const recBd = RECEITA['Best Day+'].d.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
  document.getElementById('i-tbw-taxa').innerHTML = `<b>${pct(taxa(tTbw))}</b>`;
  document.getElementById('i-bd-taxa').innerHTML = `<b>${pct(taxa(tBd))}</b>`;
  document.getElementById('i-tbw-tk').innerHTML = `<b>${brl(recTbw[1] / recTbw[0], true)}</b>`;
  document.getElementById('i-bd-tk').innerHTML = `<b>${brl(recBd[1] / recBd[0], true)}</b>`;

  /* 4. receita */
  const FRENTES = [
    { nome: 'TBW Weekend', cor: C1(), d: RECEITA['TBW Weekend'].d },
    { nome: 'Best Day+', cor: C2(), d: RECEITA['Best Day+'].d },
    { nome: 'Mentorias + Base (expansão)', cor: C3(), d: EXPANSAO.vendas.map((v, i) => [v, EXPANSAO.receita[i]]) },
  ];
  legenda('#lg-rec', FRENTES);
  grafico('#c-rec', w => empilhadas({
    w, rotulos: ROTULO, yFmt: v => v >= 1e6 ? nf1.format(v / 1e6) + ' mi' : nf.format(v / 1e3) + 'k',
    series: FRENTES.map(f => ({ nome: f.nome, cor: f.cor, dados: f.d.map(x => x[1]) })),
    tipFmt: (se, i) => {
      const v = FRENTES.find(x => x.nome === se.nome).d[i];
      return `${brl(v[1], true)} <span style="color:var(--muted);font-weight:400">(${v[0]} vendas)</span>`;
    },
  }));
  tabela('#t-rec', ['Mês', 'TBW Weekend', 'Best Day+', 'Expansão', 'Total'],
    ROTULO.map((r, i) => {
      const [a, b, c] = FRENTES.map(f => f.d[i][1]);
      return [r, brl(a), brl(b), brl(c), brl(a + b + c)];
    }),
    (() => {
      const [a, b, c] = FRENTES.map(f => f.d.reduce((x, y) => x + y[1], 0));
      return ['jan–' + ROTULO[ult], brl(a), brl(b), brl(c), brl(a + b + c)];
    })());

  const recAq = recTbw[1] + recBd[1];
  const recEx = EXPANSAO.receita.reduce((a, b) => a + b, 0);
  const vendasAq = recTbw[0] + recBd[0];
  const vendasEx = EXPANSAO.vendas.reduce((a, b) => a + b, 0);
  document.getElementById('k-rec-aq').textContent = brl(recAq, true);
  document.getElementById('k-rec-aq-f').textContent =
    `${int(vendasAq)} vendas · ${Math.round(recAq / (recAq + recEx) * 100)}% da receita · ticket ${brl(recAq / vendasAq, true)}`;
  document.getElementById('k-rec-ex').textContent = brl(recEx, true);
  document.getElementById('k-rec-ex-f').textContent =
    `${int(vendasEx)} vendas · ${Math.round(recEx / (recAq + recEx) * 100)}% da receita · ticket ${brl(recEx / vendasEx, true)}`;
}

montar();

/* ================= hidratação ao vivo ================= */
/* Só o mês corrente vem do Worker. Os meses fechados continuam vindo dos CSVs
   versionados, que são o registro auditável e reproduzível pelas queries. */

const ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function posicaoDoMes(mes) {
  const i = MESES.indexOf(mes);
  if (i >= 0) return i;
  if (mes < MESES[MESES.length - 1]) return -1; // mês passado que já saiu da janela: ignora
  MESES.push(mes);
  ROTULO.push(ABREV[parseInt(mes.slice(5), 10) - 1]);
  B2B.metodo.push('janela_16_15');
  for (const k of ['Inbound', 'Farmer', 'Palestrante', 'TOTAL']) B2B[k].push([0, 0]);
  for (const k of ['TBW Weekend', 'Best Day+', 'TOTAL']) B2C[k].push([0, 0]);
  for (const k of Object.keys(RECEITA)) RECEITA[k].d.push([0, 0]);
  EXPANSAO.vendas.push(0); EXPANSAO.receita.push(0);
  return MESES.length - 1;
}

function hidratar(p) {
  const i = posicaoDoMes(p.mes);
  if (i < 0) return false;
  for (const k of ['Inbound', 'Farmer', 'Palestrante']) B2B[k][i] = p.b2b.canais[k] || [0, 0];
  B2B.TOTAL[i] = p.b2b.total;
  B2B.metodo[i] = p.b2b.metodo;
  for (const k of ['TBW Weekend', 'Best Day+']) B2C[k][i] = p.b2c.produtos[k] || [0, 0];
  B2C.TOTAL[i] = p.b2c.total;
  if (p.receita_b2c) {
    RECEITA['TBW Weekend'].d[i] = p.receita_b2c['TBW Weekend'] || [0, 0];
    RECEITA['Best Day+'].d[i] = p.receita_b2c['Best Day+'] || [0, 0];
    EXPANSAO.vendas[i] = (p.receita_b2c.expansao || [0, 0])[0];
    EXPANSAO.receita[i] = (p.receita_b2c.expansao || [0, 0])[1];
  }
  B2B_VENDAS_PROJETADAS = p.b2b.vendas_projetadas ?? null;
  return true;
}

function frescor(estado, texto) {
  const el = document.getElementById('frescor');
  if (!el) return;
  const cor = { vivo: 'var(--good)', parado: 'var(--warning)', estatico: 'var(--muted)' }[estado];
  el.innerHTML = `<span class="ponto" style="background:${cor}"></span>${esc(texto)}`;
  el.dataset.estado = estado;
}

function haQuanto(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!isFinite(min)) return 'agora';
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  return `há ${Math.round(min / 60)} h`;
}

async function atualizar() {
  if (!PSA_WORKER_URL) return;
  try {
    const r = await fetch(PSA_WORKER_URL.replace(/\/$/, '') + '/conversao', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const p = await r.json();
    if (p.error) throw new Error(p.error);
    if (!hidratar(p)) throw new Error('payload de mês fora da janela');
    montar();
    const ressalva = p.b2b?.janela_fechada === false ? ' · janela do B2B ainda aberta' : '';
    frescor('vivo', `${ROTULO[MESES.indexOf(p.mes)]} ao vivo · lido ${haQuanto(p.gerado_em)}${ressalva}`);
    if (p.origens_nao_mapeadas?.length) {
      console.warn('origens de lead sem mapeamento de canal:', p.origens_nao_mapeadas);
    }
  } catch (e) {
    frescor('parado', 'ao vivo indisponível — mostrando a última leitura auditada (26/08/2026)');
    console.warn('conversao: falha ao atualizar —', e.message);
  }
}

if (PSA_WORKER_URL) {
  frescor('estatico', 'carregando leitura ao vivo…');
  atualizar();
  setInterval(atualizar, INTERVALO_REFRESH_MS);
  addEventListener('visibilitychange', () => { if (!document.hidden) atualizar(); });
} else {
  frescor('estatico', 'leitura auditada de 26/08/2026 · ao vivo desligado (defina PSA_WORKER_URL)');
}

/* redesenha no resize e na troca de tema do sistema */
let t;
addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => registro.forEach(f => f()), 120); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => registro.forEach(f => f()));
