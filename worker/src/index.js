// PSA Curadoria Worker — v2 (com campos custom + calls + meetings)
// Single endpoint: POST /curadoria { dealId } -> raw deal data (frontend classifies).
// Token stays on Cloudflare; browser never sees it.

const DEAL_PROPS = [
  // Padrão HubSpot
  'dealname','amount','closedate','dealstage','description','pipeline','createdate','hs_priority',
  // Custom PSA — texto rico
  'sobre_a_oportunidade','sobre_a_empresa','quais_as_dores_deseja_resolver_com_o_evento_',
  'objetivos_do_evento','nome_do_evento','nome_da_empresa','titulo_da_oportunidade',
  // Custom PSA — estruturados (vão direto pros campos do briefing)
  'macro_tema','micro_tema','presencial_ou_online_','formato_evento','duracao_do_evento',
  'publico_estimado','quantidade_de_espectadores','budget','data_prevista_do_evento',
  'cidade_uf_do_evento','cidade','estado_negocio','criterios_atendidos',
  'origem_do_lead','origem_da_qualificacao','formato_de_empresa',
  'gravacao_transmissao_','venda_de_ingressos_','tem_suporte_de_agencia_','conseguiu_agendar_a_meet_',
];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = buildCors(origin, env.ALLOWED_ORIGINS || '');

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/curadoria' && req.method === 'POST') {
      try {
        const { dealId } = await req.json();
        if (!dealId || !/^\d+$/.test(String(dealId))) {
          return json({ error: 'dealId numérico obrigatório' }, 400, cors);
        }
        if (!env.HUBSPOT_TOKEN) {
          return json({ error: 'HUBSPOT_TOKEN não configurado no Worker' }, 500, cors);
        }
        const data = await fetchDeal(String(dealId), env.HUBSPOT_TOKEN);
        return json(data, 200, cors);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500, cors);
      }
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'psa-curadoria', version: 2 }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};

function buildCors(origin, allowedCsv) {
  const allowed = allowedCsv.split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : (allowed[0] || '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function hs(path, token) {
  const r = await fetch('https://api.hubapi.com' + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`HubSpot ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickMeetingLinks(text, into) {
  const re = /https?:\/\/(?:drive\.google\.com|docs\.google\.com|[a-z0-9.-]*zoom\.us|fathom\.video|grain\.com|fireflies\.ai|otter\.ai|tldv\.io|read\.ai|gong\.io)\/\S+/gi;
  const m = String(text || '').match(re) || [];
  for (const l of m) if (!into.includes(l)) into.push(l);
}

async function fetchDeal(dealId, token) {
  const deal = await hs(
    `/crm/v3/objects/deals/${encodeURIComponent(dealId)}` +
    `?properties=${DEAL_PROPS.join(',')}` +
    `&associations=contacts,companies,notes,calls,meetings`,
    token
  );
  const p = deal.properties || {};
  const out = {
    dealId,
    deal: p,
    notes: [],
    calls: [],
    meetings: [],
    meetingLinks: [],
    company: null,
    contact: null,
    warnings: [],
  };

  // Notes
  const noteAssocs = deal.associations?.notes?.results || [];
  for (const { id: nid } of noteAssocs.slice(0, 30)) {
    try {
      const note = await hs(`/crm/v3/objects/notes/${nid}?properties=hs_note_body,hs_createdate`, token);
      const body = stripHtml(note.properties?.hs_note_body);
      if (!body) continue;
      out.notes.push({ id: nid, body, createdate: note.properties?.hs_createdate || '' });
      pickMeetingLinks(body, out.meetingLinks);
    } catch (_) {}
  }

  // Calls (Fase 2 — precisa de crm.objects.calls.read no Private App)
  const callAssocs = deal.associations?.calls?.results || [];
  for (const { id: cid } of callAssocs.slice(0, 20)) {
    try {
      const call = await hs(
        `/crm/v3/objects/calls/${cid}?properties=hs_call_title,hs_call_body,hs_call_recording_url,hs_call_duration,hs_call_direction,hs_createdate`,
        token
      );
      const cp = call.properties || {};
      const body = stripHtml(cp.hs_call_body);
      out.calls.push({
        id: cid,
        title: cp.hs_call_title || '',
        body,
        recordingUrl: cp.hs_call_recording_url || '',
        duration: cp.hs_call_duration || '',
        direction: cp.hs_call_direction || '',
        createdate: cp.hs_createdate || '',
      });
      if (cp.hs_call_recording_url && !out.meetingLinks.includes(cp.hs_call_recording_url)) {
        out.meetingLinks.push(cp.hs_call_recording_url);
      }
      pickMeetingLinks(body, out.meetingLinks);
    } catch (e) {
      out.warnings.push(`call ${cid}: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  // Meetings (Fase 2 — precisa de crm.objects.meetings.read no Private App)
  const meetAssocs = deal.associations?.meetings?.results || [];
  for (const { id: mid } of meetAssocs.slice(0, 20)) {
    try {
      const meet = await hs(
        `/crm/v3/objects/meetings/${mid}?properties=hs_meeting_title,hs_meeting_body,hs_meeting_start_time,hs_meeting_end_time,hs_meeting_outcome,hs_internal_meeting_notes,hs_meeting_location,hs_createdate`,
        token
      );
      const mp = meet.properties || {};
      const body = stripHtml(mp.hs_meeting_body);
      const internal = stripHtml(mp.hs_internal_meeting_notes);
      out.meetings.push({
        id: mid,
        title: mp.hs_meeting_title || '',
        body,
        internalNotes: internal,
        startTime: mp.hs_meeting_start_time || '',
        endTime: mp.hs_meeting_end_time || '',
        outcome: mp.hs_meeting_outcome || '',
        location: mp.hs_meeting_location || '',
        createdate: mp.hs_createdate || '',
      });
      pickMeetingLinks(body + ' ' + internal + ' ' + (mp.hs_meeting_location || ''), out.meetingLinks);
    } catch (e) {
      out.warnings.push(`meeting ${mid}: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  // Company
  const compId = deal.associations?.companies?.results?.[0]?.id;
  if (compId) {
    try {
      const comp = await hs(
        `/crm/v3/objects/companies/${compId}?properties=name,industry,city,state,numberofemployees,website,description`,
        token
      );
      out.company = comp.properties || null;
    } catch (_) {}
  }

  // Contact
  const contId = deal.associations?.contacts?.results?.[0]?.id;
  if (contId) {
    try {
      const cont = await hs(
        `/crm/v3/objects/contacts/${contId}?properties=firstname,lastname,jobtitle,email,phone`,
        token
      );
      out.contact = cont.properties || null;
    } catch (_) {}
  }

  return out;
}
