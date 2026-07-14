#!/usr/bin/env python3
"""
Funil B2B / Leitura dos Closers — regenerador de snapshot.

Puxa todos os deals ativos no Funil de Vendas B2B da HubSpot até a etapa
"Negociação avançada", agrega por temperatura / etapa / closer + soma R$,
e regrava funil-b2b-closers.html com o novo retrato.

USO
    export HUBSPOT_TOKEN=pat-...          # Private App token
    python scripts/funil_b2b_closers.py   # regrava funil-b2b-closers.html
    python scripts/funil_b2b_closers.py --dry-run  # só imprime, não regrava
    python scripts/funil_b2b_closers.py --dump-json data/funil_snapshot.json

REQUISITOS
    Escopos no Private App: crm.objects.deals.read, crm.objects.owners.read

Snapshot é ATÔMICO — todos os cortes são do mesmo instante da consulta.
Não misturar com números tirados em outros momentos: o funil muda em tempo
real (a cobertura da leitura foi de 19% pra 71% em ~1 dia).
"""

from __future__ import annotations
import argparse, collections, datetime, html, json, os, pathlib, sys, urllib.parse, urllib.request

# ---------------------------------------------------------------------------
# Config — validado na conversa que produziu o CLAUDE.md
# ---------------------------------------------------------------------------

PIPELINE_B2B = "default"  # "Funil de Vendas B2B"

# Etapas ATIVAS até Neg. avançada. Duas reaproveitam IDs internos de fechamento
# do HubSpot (closedwon/closedlost) mas os deals continuam abertos — não
# confie no nome do ID.
STAGE_LABEL = {
    "presentationscheduled": "Conexão",
    "decisionmakerboughtin":  "Reunião agendada / Qualificado",
    "contractsent":           "Aguardando Envio de Proposta",
    "closedwon":              "Proposta enviada",
    "closedlost":             "Em negociação",
    "1167445770":             "Negociação avançada",
}
STAGE_IDS = list(STAGE_LABEL.keys())

# temperatura_atual: valor interno -> rótulo. Note "Não levo fé" -> "Larguei de mão".
TEMP_MAP = {
    "Vou vender":     "Vou vender",
    "Café com leite": "Café com leite",
    "Não levo fé":    "Larguei de mão",
}
TEMP_ORDER = ["Vou vender", "Café com leite", "Larguei de mão", "Sem leitura"]
TEMP_COLOR = {
    "Vou vender":     "var(--vender)",
    "Café com leite": "var(--cafe)",
    "Larguei de mão": "var(--largou)",
    "Sem leitura":    "var(--semler)",
}
TEMP_DESC = {
    "Vou vender":     "O closer banca a venda, independente do status.",
    "Café com leite": "Sem firmeza ainda; quer dar uma nova chance.",
    "Larguei de mão": "Sem futuro; sugere troca de jogador com oferta especial.",
}

EXCLUDE_DEALNAMES = {"TESTE LÓE (NÃO EXCLUIR)"}  # registro de teste no funil

DEAL_PROPS = [
    "dealname", "dealstage", "temperatura_atual",
    "amount_in_home_currency", "hubspot_owner_id", "deal_currency_code",
]

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML_OUT  = REPO_ROOT / "funil-b2b-closers.html"

# ---------------------------------------------------------------------------
# HubSpot API
# ---------------------------------------------------------------------------

class HubSpotClient:
    BASE = "https://api.hubapi.com"

    def __init__(self, token: str):
        self.token = token

    def _post(self, path: str, body: dict) -> dict:
        req = urllib.request.Request(
            self.BASE + path,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type":  "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    def _get(self, path: str) -> dict:
        req = urllib.request.Request(
            self.BASE + path,
            headers={"Authorization": f"Bearer {self.token}"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    def search_deals(self) -> list[dict]:
        deals, after = [], None
        while True:
            body = {
                "filterGroups": [{
                    "filters": [
                        {"propertyName": "pipeline",    "operator": "EQ", "value": PIPELINE_B2B},
                        {"propertyName": "hs_is_closed","operator": "EQ", "value": "false"},
                        {"propertyName": "dealstage",   "operator": "IN", "values": STAGE_IDS},
                    ],
                }],
                "properties": DEAL_PROPS,
                "limit": 200,
                "sorts": [{"propertyName": "hs_object_id", "direction": "ASCENDING"}],
            }
            if after:
                body["after"] = after
            resp = self._post("/crm/v3/objects/deals/search", body)
            deals.extend(resp.get("results", []))
            paging = resp.get("paging", {}).get("next")
            if not paging:
                break
            after = paging.get("after")
        return deals

    def owners(self, ids: list[int]) -> dict[int, str]:
        # /crm/v3/owners não aceita batch por id — pagina tudo e filtra
        wanted = set(ids)
        found  = {}
        after  = None
        while wanted:
            path = "/crm/v3/owners?limit=100"
            if after:
                path += "&after=" + urllib.parse.quote(str(after))
            resp = self._get(path)
            for o in resp.get("results", []):
                oid = int(o["id"])
                if oid in wanted:
                    fn = o.get("firstName","")
                    ln = o.get("lastName","")
                    found[oid] = (fn + " " + ln).strip() or o.get("email","(sem nome)")
                    wanted.discard(oid)
            nxt = resp.get("paging", {}).get("next", {}).get("after")
            if not nxt:
                break
            after = nxt
        return found

# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def temp_label(raw: str | None) -> str:
    if not raw:
        return "Sem leitura"
    return TEMP_MAP.get(raw, "Sem leitura")

def amt(p: dict) -> float:
    v = p.get("amount_in_home_currency") or 0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0

def aggregate(raw_deals: list[dict]) -> dict:
    # Dedup por id
    dedup = {d["id"]: d for d in raw_deals}
    deals = [
        d for d in dedup.values()
        if d.get("properties", {}).get("dealname", "") not in EXCLUDE_DEALNAMES
    ]

    by_temp        = collections.Counter()
    by_temp_amt    = collections.defaultdict(float)
    by_stage       = collections.Counter()
    by_stage_amt   = collections.defaultdict(float)
    by_stage_temp  = collections.defaultdict(lambda: collections.Counter())
    by_owner       = collections.Counter()
    by_owner_amt   = collections.defaultdict(float)
    by_owner_temp  = collections.defaultdict(lambda: collections.Counter())
    untag_by_stage = collections.defaultdict(list)

    for d in deals:
        p = d.get("properties", {})
        st, tp = p.get("dealstage","?"), temp_label(p.get("temperatura_atual"))
        ow, v  = p.get("hubspot_owner_id","(sem dono)"), amt(p)
        by_temp[tp] += 1
        by_temp_amt[tp] += v
        by_stage[st] += 1
        by_stage_amt[st] += v
        by_stage_temp[st][tp] += 1
        by_owner[ow] += 1
        by_owner_amt[ow] += v
        by_owner_temp[ow][tp] += 1
        if tp == "Sem leitura":
            untag_by_stage[st].append({"id": d["id"], "name": p.get("dealname",""), "owner": ow, "amount": v})

    tagged = sum(n for t,n in by_temp.items() if t != "Sem leitura")

    return {
        "total_active":    len(deals),
        "tagged":          tagged,
        "untag":           len(deals) - tagged,
        "total_amount":    sum(by_stage_amt.values()),
        "by_temp":         dict(by_temp),
        "by_temp_amount":  dict(by_temp_amt),
        "by_stage":        dict(by_stage),
        "by_stage_amount": dict(by_stage_amt),
        "by_stage_temp":   {k: dict(v) for k, v in by_stage_temp.items()},
        "by_owner":        dict(by_owner),
        "by_owner_amount": dict(by_owner_amt),
        "by_owner_temp":   {k: dict(v) for k, v in by_owner_temp.items()},
        "untag_by_stage":  {k: v for k, v in untag_by_stage.items()},
    }

# ---------------------------------------------------------------------------
# HTML generation
# ---------------------------------------------------------------------------

def fmt_brl(v: float) -> str:
    # 1.234,56 estilo pt-BR
    s = f"{v:,.2f}"
    return "R$ " + s.replace(",", "X").replace(".", ",").replace("X", ".")

def fmt_int(n: int) -> str:
    return f"{n:,}".replace(",", ".")

def build_html(agg: dict, owner_names: dict[int, str], ts_label: str) -> str:
    active = agg["total_active"]
    tagged = agg["tagged"]
    untag  = agg["untag"]
    mix    = [{"key": t, "n": agg["by_temp"].get(t,0), "v": agg["by_temp_amount"].get(t,0.0),
               "c": TEMP_COLOR[t], "desc": TEMP_DESC.get(t,"")} for t in ["Vou vender","Café com leite","Larguei de mão"]]
    vv     = agg["by_temp"].get("Vou vender", 0)
    pf     = lambda a,b,d=1: (f"{100*a/b:.{d}f}%".replace(".", ",")) if b else "0%"

    # closer rows: nome, deals, R$, dist temp
    owners_sorted = sorted(agg["by_owner"].items(), key=lambda kv: -kv[1])
    owner_rows = []
    for oid_str, n in owners_sorted:
        try: oid = int(oid_str)
        except ValueError: oid = None
        name = owner_names.get(oid, oid_str) if oid else oid_str
        v    = agg["by_owner_amount"].get(oid_str, 0.0)
        dist = agg["by_owner_temp"].get(oid_str, {})
        owner_rows.append({"name": name, "n": n, "v": v,
                           "vv": dist.get("Vou vender",0),
                           "cf": dist.get("Café com leite",0),
                           "lg": dist.get("Larguei de mão",0),
                           "sr": dist.get("Sem leitura",0)})

    # trabalho — top sem-leitura por etapa avançada (Neg. avançada -> Conexão)
    stage_priority = ["1167445770","closedlost","closedwon","contractsent","decisionmakerboughtin","presentationscheduled"]
    worklist = []
    for st in stage_priority:
        for d in agg["untag_by_stage"].get(st, []):
            try: oid = int(d["owner"])
            except (TypeError, ValueError): oid = None
            worklist.append({
                "id": d["id"], "name": d["name"],
                "stage": STAGE_LABEL.get(st, st),
                "owner": owner_names.get(oid, d["owner"]) if oid else d["owner"],
                "amount": d["amount"],
            })
        if len(worklist) >= 30:
            break
    worklist = worklist[:30]

    # embed data as JSON in <script>
    payload = {
        "generatedAt": ts_label,
        "active":      active,
        "tagged":      tagged,
        "untag":       untag,
        "totalAmount": agg["total_amount"],
        "mix":         mix,
        "byStage":     [{"key": STAGE_LABEL[s], "id": s,
                         "n": agg["by_stage"].get(s,0),
                         "v": agg["by_stage_amount"].get(s,0.0),
                         "dist": {t: agg["by_stage_temp"].get(s,{}).get(t,0) for t in TEMP_ORDER}}
                        for s in STAGE_IDS],
        "owners":      owner_rows,
        "worklist":    worklist,
    }

    return HTML_TEMPLATE.replace("__PAYLOAD__", json.dumps(payload, ensure_ascii=False))

# HTML template — self-contained, dark theme, matches existing design tokens.
HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Funil B2B · Relatório de Gestão</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#14100E;--panel:#1E1714;--panel2:#241C18;--line:#3A2E25;--ink:#F1EAE1;--mut:#A79C90;--dim:#75695E;
--vender:#F0883E;--cafe:#CBB08A;--largou:#6E93B0;--semler:#4E453D;--ganha:#7BB185;--perdida:#B06A5D;--resting:#7C8AA0;--radius:14px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:'Inter',system-ui,sans-serif;font-size:15px;line-height:1.5;
background-image:radial-gradient(1200px 500px at 80% -10%, #241a13 0%, transparent 60%)}
.wrap{max-width:1180px;margin:0 auto;padding:32px 22px 80px}
.num{font-family:'Space Mono',monospace;font-feature-settings:"tnum"}
h1,h2{font-family:'Space Grotesk',sans-serif;font-weight:600;margin:0}
.eyebrow{font-family:'Space Mono';font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--vender);margin:0 0 10px}
h1{font-size:clamp(26px,4vw,40px);letter-spacing:-.01em;line-height:1.08}
header .sub{color:var(--mut);max-width:64ch;margin:12px 0 0}
.meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:16px;font-family:'Space Mono';font-size:12px;color:var(--dim)}
.meta b{color:var(--mut);font-weight:400}
.callout{margin-top:20px;background:linear-gradient(90deg,#241a12,#1e1714);border:1px solid var(--line);border-left:3px solid var(--vender);border-radius:10px;padding:14px 16px;font-size:14px}
.callout b{color:var(--vender)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.kpi .lab{font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut)}
.kpi .big{font-family:'Space Grotesk';font-weight:700;font-size:30px;margin-top:8px;letter-spacing:-.02em}
.kpi .foot{font-family:'Space Mono';font-size:12px;color:var(--dim);margin-top:4px}
section{margin-top:36px}
.shead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.shead h2{font-size:19px}.shead .note{color:var(--dim);font-size:12.5px;font-family:'Space Mono'}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:22px}
.bar{display:flex;height:46px;border-radius:9px;overflow:hidden;border:1px solid #00000040}
.seg{display:flex;align-items:center;justify-content:center;min-width:2px;font-family:'Space Mono';font-size:12px;font-weight:700;transition:flex .5s}
.leg{display:flex;flex-wrap:wrap;gap:14px 22px;margin-top:16px}
.chip{display:flex;align-items:center;gap:8px;font-size:13px}.chip .dot{width:12px;height:12px;border-radius:3px}
.chip .n{font-family:'Space Mono';color:var(--mut);font-size:12px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{border-radius:var(--radius);padding:20px;border:1px solid var(--line);background:var(--panel);position:relative;overflow:hidden}
.card::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--c)}
.card .tag{display:flex;align-items:center;gap:9px;font-family:'Space Grotesk';font-weight:600;font-size:16px}
.card .tag .sq{width:13px;height:13px;border-radius:3px;background:var(--c)}
.card .desc{color:var(--dim);font-size:12px;margin:6px 0 16px;min-height:32px}
.card .n2{font-family:'Space Grotesk';font-weight:700;font-size:36px;letter-spacing:-.02em;line-height:1}
.card .of{color:var(--dim);font-size:12px;font-family:'Space Mono';margin-top:5px}
.card .rs{color:var(--mut);font-size:13px;font-family:'Space Mono';margin-top:8px}
.card .rs b{color:var(--ink);font-weight:700}

.stgrid{display:grid;grid-template-columns:1fr;gap:9px}
.stgrid.h{grid-template-columns:1.6fr .8fr 1fr 2fr;padding:0 4px;font-size:11px;color:var(--mut);letter-spacing:.05em;text-transform:uppercase;margin-bottom:4px}
.stgrid.h span{font-family:'Space Mono'}
.strow{display:grid;grid-template-columns:1.6fr .8fr 1fr 2fr;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:11px;background:var(--panel2)}
.strow .name{font-weight:600}
.strow .n,.strow .rs{font-family:'Space Mono'}
.strow .rs{color:var(--mut);font-size:13px}
.mini{display:flex;height:20px;border-radius:5px;overflow:hidden;border:1px solid #00000040}
.mini span{display:flex;align-items:center;justify-content:center;font-family:'Space Mono';font-size:10px;font-weight:700;color:#1a130e;transition:flex .5s}

.otbl{width:100%;border-collapse:collapse;font-size:13.5px}
.otbl th,.otbl td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line)}
.otbl th{font-family:'Space Mono';font-size:11px;color:var(--mut);letter-spacing:.04em;text-transform:uppercase;font-weight:400}
.otbl td.n{font-family:'Space Mono';text-align:right}
.otbl td.mini-cell{width:200px}
.otbl tr.alert td{background:linear-gradient(90deg,#3a1f13 0%,transparent 60%);border-left:3px solid var(--largou)}

.worktbl{width:100%;border-collapse:collapse;font-size:13px}
.worktbl th,.worktbl td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line)}
.worktbl th{font-family:'Space Mono';font-size:11px;color:var(--mut);letter-spacing:.04em;text-transform:uppercase;font-weight:400}
.worktbl td.n{font-family:'Space Mono';text-align:right}
.worktbl td .stg{display:inline-block;padding:2px 8px;border:1px solid var(--line);border-radius:5px;font-family:'Space Mono';font-size:11px;color:var(--mut)}

.reco{background:linear-gradient(90deg,#12201a,#1e1714);border:1px solid #2c4a3a;border-left:3px solid var(--ganha);border-radius:12px;padding:18px 20px;margin-top:36px}
.reco h3{font-family:'Space Grotesk';margin:0 0 8px;font-size:16px;color:var(--ganha)}
.reco p{margin:6px 0;font-size:13.5px;color:var(--ink)}.reco b{color:#9fd6ab}
.foot{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);color:var(--dim);font-size:12px;font-family:'Space Mono';line-height:1.7}
@media(max-width:820px){.kpis{grid-template-columns:repeat(2,1fr)}.cards{grid-template-columns:1fr}.stgrid.h,.strow{grid-template-columns:1fr .8fr 1fr;} .stgrid.h span:nth-child(4),.strow > *:nth-child(4){display:none}}
</style></head><body><div class="wrap">
<header>
 <p class="eyebrow">Relatório de gestão · Funil de Vendas B2B</p>
 <h1>Leitura dos closers<br>sobre o funil ativo</h1>
 <p class="sub">Negócios <b>ativos</b> até <b>Negociação avançada</b>, pela temperatura que o closer atribui a cada um. A pergunta de gestão: quanto do funil o time banca (<b>Vou vender</b>), dá nova chance (<b>Café com leite</b>) ou já solta (<b>Larguei de mão</b>) — e quanto isso representa em R$.</p>
 <div class="meta"><span><b>Snapshot:</b> <span id="ts"></span></span><span><b>Pipeline:</b> Funil de Vendas B2B</span><span><b>Recorte:</b> Conexão → Negociação avançada</span></div>
 <div class="callout" id="callout"></div>
</header>

<div class="kpis">
 <div class="kpi"><div class="lab">Ativas no funil</div><div class="big num" id="k1"></div><div class="foot" id="k1f"></div></div>
 <div class="kpi"><div class="lab">Com leitura</div><div class="big num" id="k2"></div><div class="foot" id="k2f"></div></div>
 <div class="kpi"><div class="lab">Sem leitura</div><div class="big num" id="k3"></div><div class="foot" id="k3f"></div></div>
 <div class="kpi"><div class="lab">Convicção "Vou vender"</div><div class="big num" id="k4"></div><div class="foot" id="k4f"></div></div>
</div>

<section><div class="shead"><h2>Termômetro do funil</h2><span class="note" id="tn"></span></div>
 <div class="panel"><div class="bar" id="thermo"></div><div class="leg" id="leg"></div></div></section>

<section><div class="shead"><h2>As três etiquetas — deals e valor (R$)</h2><span class="note">dentro dos negócios com leitura</span></div>
 <div class="cards" id="cards"></div></section>

<section><div class="shead"><h2>Por etapa</h2><span class="note">contagem, valor e mix da leitura</span></div>
 <div class="panel">
  <div class="stgrid h"><span>Etapa</span><span style="text-align:right">Deals</span><span style="text-align:right">Valor (R$)</span><span>Mix da leitura</span></div>
  <div class="stgrid" id="stgrid"></div>
 </div></section>

<section><div class="shead"><h2>Por closer</h2><span class="note">quem banca, quem larga, quem ainda não leu</span></div>
 <div class="panel"><table class="otbl" id="otbl">
  <thead><tr><th>Closer</th><th style="text-align:right">Deals</th><th style="text-align:right">Valor (R$)</th><th>Mix da leitura</th></tr></thead>
  <tbody></tbody>
 </table></div></section>

<section><div class="shead"><h2>Lista de trabalho — sem leitura</h2><span class="note">até 30 · priorizados por etapa avançada</span></div>
 <div class="panel"><table class="worktbl" id="worktbl">
  <thead><tr><th>Deal</th><th>Etapa</th><th>Dono</th><th style="text-align:right">Valor (R$)</th></tr></thead>
  <tbody></tbody>
 </table></div></section>

<div class="reco"><h3>Sinal pra gestão</h3>
 <p id="reco-p"></p></div>

<div class="foot" id="foot"></div>
</div>
<script>
const D=__PAYLOAD__;
const fmt=n=>n.toLocaleString("pt-BR");
const brl=n=>"R$ "+n.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
const pf=(a,b,d=1)=>b?(100*a/b).toLocaleString("pt-BR",{maximumFractionDigits:d})+"%":"0%";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const COL={"Vou vender":"var(--vender)","Café com leite":"var(--cafe)","Larguei de mão":"var(--largou)","Sem leitura":"var(--semler)"};

document.getElementById("ts").textContent=D.generatedAt;
const vv=D.mix[0].n, cf=D.mix[1].n, lg=D.mix[2].n;

document.getElementById("k1").textContent=fmt(D.active);
document.getElementById("k1f").textContent=brl(D.totalAmount)+" · até Neg. avançada";
document.getElementById("k2").textContent=fmt(D.tagged);
document.getElementById("k2f").textContent=pf(D.tagged,D.active)+" do funil";
document.getElementById("k3").textContent=fmt(D.untag);
document.getElementById("k3f").textContent=pf(D.untag,D.active)+" restante";
document.getElementById("k4").textContent=pf(vv,D.tagged);
document.getElementById("k4f").textContent=fmt(vv)+" de "+fmt(D.tagged)+" lidos · "+brl(D.mix[0].v);

document.getElementById("callout").innerHTML=
 `Cobertura da leitura: <b>${pf(D.tagged,D.active)}</b> do funil ativo. Convicção: só <b>${pf(vv,D.tagged)}</b> dos lidos é "Vou vender" — a maior parte é "Café com leite" (${pf(cf,D.tagged)}) e ${pf(lg,D.tagged)} já é "Larguei de mão". Valor em jogo: <b>${brl(D.totalAmount)}</b>.`;

// Termômetro
const spectrum=[...D.mix.map(m=>({k:m.key,n:m.n,c:m.c})),{k:"Sem leitura",n:D.untag,c:"var(--semler)"}];
const tb=document.getElementById("thermo"),lg2=document.getElementById("leg");
document.getElementById("tn").textContent=fmt(D.active)+" negócios ativos · "+brl(D.totalAmount);
spectrum.forEach(s=>{const e=document.createElement("div");e.className="seg";e.style.flex=s.n;e.style.background=s.c;
 e.style.color=s.k==="Sem leitura"?"#cbb8a8":"#1a130e";e.textContent=(s.n/D.active>0.05)?s.n:"";tb.appendChild(e);});
spectrum.forEach(s=>{const c=document.createElement("div");c.className="chip";
 c.innerHTML=`<span class="dot" style="background:${s.c}"></span>${esc(s.k)} <span class="n">${s.n} · ${pf(s.n,D.active)}</span>`;lg2.appendChild(c);});

// 3 etiquetas
const cw=document.getElementById("cards");
D.mix.forEach(m=>{const el=document.createElement("div");el.className="card";el.style.setProperty("--c",m.c);
 el.innerHTML=`<div class="tag"><span class="sq"></span>${esc(m.key)}</div><div class="desc">${esc(m.desc)}</div>
 <div class="n2 num">${fmt(m.n)}</div><div class="of">${pf(m.n,D.tagged)} da leitura · ${pf(m.n,D.active)} do funil ativo</div>
 <div class="rs">Valor em jogo: <b>${brl(m.v)}</b></div>`;cw.appendChild(el);});

// Por etapa
const stg=document.getElementById("stgrid");
D.byStage.forEach(s=>{
  const row=document.createElement("div");row.className="strow";
  const mini=document.createElement("div");mini.className="mini";
  ["Vou vender","Café com leite","Larguei de mão","Sem leitura"].forEach(t=>{
    const n=s.dist[t]||0;if(!n) return;
    const seg=document.createElement("span");seg.style.flex=n;seg.style.background=COL[t];
    seg.textContent=(n/s.n>0.15)?n:"";
    if(t==="Sem leitura") seg.style.color="#cbb8a8";
    mini.appendChild(seg);
  });
  row.innerHTML=`<div class="name">${esc(s.key)}</div><div class="n" style="text-align:right">${fmt(s.n)}</div><div class="rs" style="text-align:right">${brl(s.v)}</div>`;
  row.appendChild(mini);
  stg.appendChild(row);
});

// Closers
const otb=document.querySelector("#otbl tbody");
D.owners.forEach(o=>{
  const tr=document.createElement("tr");
  // alerta: closer que marcou TUDO como Larguei de mão
  if(o.n>=10 && o.lg===o.n) tr.classList.add("alert");
  const mini=[["Vou vender",o.vv],["Café com leite",o.cf],["Larguei de mão",o.lg],["Sem leitura",o.sr]]
    .filter(([_,n])=>n>0)
    .map(([t,n])=>`<span style="flex:${n};background:${COL[t]};${t==="Sem leitura"?"color:#cbb8a8":""}">${n/o.n>0.15?n:""}</span>`).join("");
  tr.innerHTML=`<td>${esc(o.name)}</td><td class="n">${fmt(o.n)}</td><td class="n">${brl(o.v)}</td><td class="mini-cell"><div class="mini">${mini}</div></td>`;
  otb.appendChild(tr);
});

// Lista de trabalho
const wtb=document.querySelector("#worktbl tbody");
D.worklist.forEach(w=>{
  const tr=document.createElement("tr");
  tr.innerHTML=`<td>${esc(w.name)}</td><td><span class="stg">${esc(w.stage)}</span></td><td>${esc(w.owner)}</td><td class="n">${w.amount?brl(w.amount):"—"}</td>`;
  wtb.appendChild(tr);
});
if(D.worklist.length===0){
  const tr=document.createElement("tr");
  tr.innerHTML='<td colspan="4" style="color:var(--dim);text-align:center;padding:20px">🎉 Nenhum deal sem leitura — 100% de cobertura</td>';
  wtb.appendChild(tr);
}

// Sinal pra gestão: destaca closers alertados
const alerted=D.owners.filter(o=>o.n>=10 && o.lg===o.n);
const recoEl=document.getElementById("reco-p");
if(alerted.length){
  const parts=alerted.map(o=>`<b>${esc(o.name)}</b> (${o.n} deals · ${brl(o.v)})`);
  recoEl.innerHTML=`Closers que marcaram <b>100% da carteira ativa como "Larguei de mão"</b> — sinal de que largaram o funil, não que os deals são ruins: ${parts.join(", ")}. Vale conversa 1:1 pra entender e, se for o caso, redistribuir.`;
}else{
  recoEl.innerHTML=`Nenhum closer com carteira ativa marcada 100% como "Larguei de mão". Continue monitorando cobertura da leitura — hoje em <b>${pf(D.tagged,D.active)}</b>.`;
}

document.getElementById("foot").innerHTML=`Fonte: HubSpot · campo <b>temperatura_atual</b> · 6 etapas abertas até Neg. avançada. "Larguei de mão" = valor interno "Não levo fé". Snapshot <b>${D.generatedAt}</b>: ${fmt(D.active)} deals ativos, ${brl(D.totalAmount)} em jogo. Cortes coerentes entre si (mix soma ${fmt(D.tagged+D.untag)}, casa com "Ativas"). O funil muda em tempo real — este é um retrato do instante da consulta. Excluído: registro de teste "TESTE LÓE (NÃO EXCLUIR)".`;
</script></body></html>
"""

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="não regrava o HTML; só imprime resumo")
    ap.add_argument("--dump-json", metavar="PATH", help="grava o snapshot agregado (JSON) neste caminho")
    ap.add_argument("--from-json", metavar="PATH", help="lê deals crus de um JSON local em vez de chamar a HubSpot (formato: {'results':[...]})")
    args = ap.parse_args()

    if args.from_json:
        with open(args.from_json) as f:
            raw = json.load(f).get("results", [])
        owner_names = {}
    else:
        token = os.environ.get("HUBSPOT_TOKEN")
        if not token:
            sys.exit("HUBSPOT_TOKEN não está no ambiente. Exporte antes de rodar.")
        hs = HubSpotClient(token)
        print(f"[fetch] paginando /crm/v3/objects/deals/search ...", file=sys.stderr)
        raw = hs.search_deals()
        print(f"[fetch] {len(raw)} deals recebidos", file=sys.stderr)
        owner_ids = {int(d["properties"]["hubspot_owner_id"])
                     for d in raw
                     if d.get("properties",{}).get("hubspot_owner_id","").isdigit()}
        print(f"[fetch] resolvendo {len(owner_ids)} owner(s)...", file=sys.stderr)
        owner_names = hs.owners(sorted(owner_ids))

    agg = aggregate(raw)

    print(f"\n=== SNAPSHOT ===")
    print(f"  ativos:       {agg['total_active']}")
    print(f"  R$ em jogo:   {fmt_brl(agg['total_amount'])}")
    print(f"  com leitura:  {agg['tagged']} ({100*agg['tagged']/max(1,agg['total_active']):.1f}%)")
    print(f"  sem leitura:  {agg['untag']}")
    for t in TEMP_ORDER:
        n = agg["by_temp"].get(t, 0)
        v = agg["by_temp_amount"].get(t, 0.0)
        print(f"  {t:16s} {n:4d} · {fmt_brl(v)}")

    if args.dump_json:
        pathlib.Path(args.dump_json).parent.mkdir(parents=True, exist_ok=True)
        with open(args.dump_json, "w", encoding="utf-8") as f:
            json.dump({"snapshot": agg, "owner_names": {str(k): v for k, v in owner_names.items()}}, f, ensure_ascii=False, indent=2)
        print(f"[write] {args.dump_json}")

    if args.dry_run:
        print("[dry-run] HTML não regravado.")
        return

    ts_label = datetime.datetime.now().strftime("%d/%m/%Y · %Hh%M")
    html_out = build_html(agg, owner_names, ts_label)
    HTML_OUT.write_text(html_out, encoding="utf-8")
    print(f"[write] {HTML_OUT} ({len(html_out):,} bytes)")

if __name__ == "__main__":
    main()
