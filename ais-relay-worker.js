// Fahrwasser AIS-Relay (Cloudflare Worker)
// aisstream.io erlaubt keine Browser-Verbindungen. Dieser Worker verbindet sich
// serverseitig, sammelt einige Sekunden Meldungen im Kartenausschnitt und liefert JSON.
//
// Secret:    AISSTREAM_API_KEY   (Pflicht)
// Variablen: ALLOWED_ORIGIN      (z.B. https://fahrwasser.example.ch, Standard *)
//            WINDOW_MS           (Sammeldauer, Standard 8000)

const MAX_SPAN_DEG = 3;
const TTL_MS = 15000;
const memo = new Map(); // Kurzzeit-Cache pro Isolate, entlastet aisstream

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return json({ error: 'method' }, 405, cors);
    if (!env.AISSTREAM_API_KEY) return json({ error: 'not_configured' }, 503, cors);

    const b = (new URL(request.url).searchParams.get('bbox') || '').split(',').map(Number);
    if (b.length !== 4 || b.some(v => !Number.isFinite(v))) return json({ error: 'bbox' }, 400, cors);

    // Auf 0.05° runden und leicht erweitern, damit benachbarte Ausschnitte den Cache teilen
    const r = v => Math.round(v * 20) / 20;
    const box = [r(b[0]) - 0.05, r(b[1]) - 0.05, r(b[2]) + 0.05, r(b[3]) + 0.05].map(v => +v.toFixed(2));
    const [w, s, e, n] = box;
    if (e - w > MAX_SPAN_DEG || n - s > MAX_SPAN_DEG) return json({ error: 'bbox_too_large' }, 413, cors);

    const key = box.join(',');
    const cached = memo.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) return json(cached.body, 200, cors);

    try {
      const t0 = Date.now();
      const { ships, dbg } = await collect(env.AISSTREAM_API_KEY, box, Number(env.WINDOW_MS) || 8000);
      const body = { ts: new Date().toISOString(), bbox: box, ships, debug: { ...dbg, ms: Date.now() - t0 } };
      memo.set(key, { at: Date.now(), body });
      if (memo.size > 200) memo.delete(memo.keys().next().value);
      return json(body, 200, cors);
    } catch (err) {
      return json({ error: 'upstream', detail: String(err && err.message || err) }, 502, cors);
    }
  }
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=15' }
  });
}

async function collect(apiKey, [w, s, e, n], windowMs) {
  const resp = await fetch('https://stream.aisstream.io/v0/stream', { headers: { Upgrade: 'websocket' } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`handshake ${resp.status}`);
  ws.accept();
  ws.send(JSON.stringify({
    APIKey: apiKey,
    BoundingBoxes: [[[s, w], [n, e]]], // Format: [[lat, lon], [lat, lon]]
    FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport']
  }));

  const ships = new Map();
  const dec = new TextDecoder();
  const dbg = { handshake: resp.status, msgs: 0, types: {}, close: null, first: null };
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = err => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { ws.close(1000, 'done'); } catch {}
      err && !ships.size ? reject(err) : resolve({ ships: [...ships.values()].filter(x => Number.isFinite(x.lat) || x.name), dbg });
    };
    const timer = setTimeout(() => finish(), windowMs);
    ws.addEventListener('message', ev => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : dec.decode(ev.data);
        dbg.msgs++; if (!dbg.first) dbg.first = raw.slice(0, 160);
        const m = JSON.parse(raw);
        dbg.types[m.MessageType || (m.error ? 'error' : '?')] = (dbg.types[m.MessageType || (m.error ? 'error' : '?')] || 0) + 1;
        if (m.error) return finish(new Error(m.error));
        merge(ships, m);
      } catch {}
    });
    ws.addEventListener('close', ev => { dbg.close = { code: ev.code, reason: ev.reason, clean: ev.wasClean }; finish(); });
    ws.addEventListener('error', ev => { dbg.close = { error: String(ev && ev.message || 'socket') }; finish(new Error('socket')); });
  });
}

function merge(ships, m) {
  const md = m.MetaData || {};
  const mmsi = Number(md.MMSI);
  if (!mmsi) return;
  const s = ships.get(mmsi) || { mmsi };
  const nm = (md.ShipName || '').trim();
  if (nm) s.name = nm;
  const body = (m.Message && m.Message[m.MessageType]) || {};

  switch (m.MessageType) {
    case 'PositionReport':
    case 'StandardClassBPositionReport':
    case 'ExtendedClassBPositionReport': {
      if (Number.isFinite(md.latitude) && Number.isFinite(md.longitude)) { s.lat = md.latitude; s.lon = md.longitude; }
      if (body.Sog != null && body.Sog < 102.3) s.sog = body.Sog;
      if (body.Cog != null && body.Cog < 360) s.cog = body.Cog;
      if (body.TrueHeading != null && body.TrueHeading < 360) s.hdg = body.TrueHeading;
      if (body.NavigationalStatus != null) s.nav = body.NavigationalStatus;
      s.t = parseTime(md.time_utc);
      break;
    }
    case 'ShipStaticData': {
      if (body.Name) s.name = body.Name.trim();
      if (body.Destination) s.dest = body.Destination.trim();
      if (body.Type != null) s.type = body.Type;
      if (body.Dimension) s.len = (body.Dimension.A || 0) + (body.Dimension.B || 0) || undefined;
      break;
    }
    case 'StaticDataReport': {
      const a = body.ReportA, b = body.ReportB;
      if (a && a.Valid && a.Name) s.name = a.Name.trim();
      if (b && b.Valid && b.ShipType != null) s.type = b.ShipType;
      break;
    }
  }
  ships.set(mmsi, s);
}

// aisstream liefert z.B. "2026-09-25 07:01:02.123456 +0000 UTC"
function parseTime(x) {
  const m = String(x || '').match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}Z` : new Date().toISOString();
}
