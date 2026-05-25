// PSA Curadoria Worker
// Single endpoint: POST /curadoria { dealId } -> raw deal data (frontend classifies).
// Token stays on Cloudflare; browser never sees it.

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
      return json({ ok: true, service: 'psa-curadoria' }, 200, cors);
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

async function fetchDeal(dealId, token) {
  const dealProps = ['dealname', 'amount', 'closedate', 'dealstage', 'description', 'pipeline', 'createdate', 'hs_priority'];
  const deal = await hs(
    `/crm/v3/objects/deals/${encodeURIComponent(dealId)}` +
    `?properties=${dealProps.join(',')}` +
    `&associations=contacts,companies,notes`,
    token
  );
  const p = deal.properties || {};
  const out = {
    dealId,
    deal: {
      name: p.dealname || '',
      amount: p.amount ? parseFloat(p.amount) : null,
      closedate: p.closedate || '',
      stage: p.dealstage || '',
      description: p.description || '',
      pipeline: p.pipeline || '',
    },
    notes: [],
    meetingLinks: [],
    company: null,
    contact: null,
  };

  const noteAssocs = deal.associations?.notes?.results || [];
  for (const { id: nid } of noteAssocs.slice(0, 30)) {
    try {
      const note = await hs(`/crm/v3/objects/notes/${nid}?properties=hs_note_body,hs_createdate`, token);
      const body = stripHtml(note.properties?.hs_note_body);
      if (!body) continue;
      out.notes.push({ id: nid, body, createdate: note.properties?.hs_createdate || '' });
      const links = body.match(/https?:\/\/(?:drive\.google\.com|docs\.google\.com|[a-z0-9.-]*zoom\.us|fathom\.video|grain\.com|fireflies\.ai|otter\.ai|tldv\.io|read\.ai|gong\.io)\/\S+/gi) || [];
      for (const l of links) if (!out.meetingLinks.includes(l)) out.meetingLinks.push(l);
    } catch (_) {}
  }

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
