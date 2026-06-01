/* =============================================================================
 * Woldt Consulting — Practice Pulse metrics aggregator (v3: fully live)
 * -----------------------------------------------------------------------------
 * Feeds the /api/metrics SSE stream from real sources, per DR-001 + DR-002:
 *   • discovery_calls           <- Cal.com webhook   (BOOKING_CREATED)
 *   • leads, week_total, history<- HubSpot Free CRM   (contacts created)
 *   • engagements               <- HubSpot Free CRM   (deals in active stage)
 *   • sessions_live, _today     <- Plausible Stats API (realtime + today)
 *
 * DATA_SOURCE modes (env):
 *   'live'       — everything real (HubSpot + Plausible + Cal.com webhook).
 *                  Any source missing its credentials is skipped (its metric
 *                  holds its last value); the others still run.
 *   'cal'        — discovery_calls real (Cal.com); the rest simulated.
 *   'simulated'  — everything simulated (no credentials needed).
 *
 * Requires Node 18+ (uses global fetch). Selected tools: HubSpot Free CRM +
 * Plausible (DR-002, signed 2026-05-31).
 * ===========================================================================*/

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';   // e.g. https://woldtconsulting.com (unset = allow all, for dev)
app.use(cors(ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN } : {}));                                  // lock to your site origin in production
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

/* --------------------------------- config -------------------------------- */
const CFG = {
  port:            process.env.PORT || 8787,
  source:          process.env.DATA_SOURCE || 'cal',
  calSecret:       process.env.CAL_WEBHOOK_SECRET || '',

  hubspotToken:    process.env.HUBSPOT_TOKEN || '',                 // Private App token
  engagementStage: process.env.HUBSPOT_ENGAGEMENT_STAGE || '',      // deal stage id = "active engagement"

  plausibleKey:    process.env.PLAUSIBLE_API_KEY || '',
  plausibleSite:   process.env.PLAUSIBLE_SITE_ID || '',             // e.g. woldtconsulting.com
  plausibleHost:   process.env.PLAUSIBLE_HOST || 'https://plausible.io',

  pollCrmMs:       +(process.env.POLL_CRM_MS || 300000),            // 5 min
  pollLiveMs:      +(process.env.POLL_LIVE_MS || 30000),            // 30 s
  pollTodayMs:     +(process.env.POLL_TODAY_MS || 120000),          // 2 min
};
const DAY = 86400000;

/* ----------------------------- metrics model ----------------------------- */
const metrics = {
  discovery_calls: 0,
  leads: 0,
  engagements: 0,
  sessions_live: 0,
  sessions_today: 0,
  week_total: 0,
  history: [0, 0, 0, 0, 0, 0, 0],
};
const TAGS = ['Medical Devices', 'Healthcare', 'Financial Services', 'Public Sector'];

/* ----------------------------- SSE plumbing ------------------------------ */
const clients = new Set();
function send(res, event, data) { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const r of clients) { try { send(r, event, data); } catch (_) {} } }
const bus = {
  setMetric(k, v) { if (metrics[k] !== v) { metrics[k] = v; broadcast('metric', { key: k, value: v }); } },
  bumpMetric(k, d = 1) { this.setMetric(k, (metrics[k] || 0) + d); },
  setHistory(arr) { metrics.history = arr; broadcast('metric', { key: 'history', value: arr }); },
  pushHistoryPoint(v) { this.setHistory([...metrics.history.slice(1), v]); },
  activity(text, tag, ago = 'just now') { broadcast('activity', { text, tag: tag || TAGS[0], ago }); },
};

app.get('/api/metrics', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 5000\n\n');
  send(res, 'snapshot', metrics);
  clients.add(res);
  const ka = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ka); clients.delete(res); });
});
app.get('/healthz', (_req, res) => res.json({ ok: true, clients: clients.size, source: CFG.source, metrics }));

/* ===========================  Cal.com webhook  ============================ */
function verifyCalSignature(req) {
  if (!CFG.calSecret) return true;
  const sig = req.get('X-Cal-Signature-256') || '';
  const digest = crypto.createHmac('sha256', CFG.calSecret).update(req.rawBody || Buffer.from('')).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig)); } catch (_) { return false; }
}
function industryTagFrom(payload) {
  const r = payload && payload.responses;
  const val = r && (r.Industry || r.industry) && ((r.Industry || r.industry).value || (r.Industry || r.industry));
  if (typeof val === 'string') { const hit = TAGS.find(t => t.toLowerCase() === val.toLowerCase()); if (hit) return hit; }
  return TAGS[Math.floor(Math.random() * TAGS.length)];
}
app.post('/webhooks/cal', (req, res) => {
  if (!verifyCalSignature(req)) return res.status(401).json({ error: 'bad signature' });
  const { triggerEvent, payload = {} } = req.body || {};
  const tag = industryTagFrom(payload);
  if (triggerEvent === 'BOOKING_CREATED') { bus.bumpMetric('discovery_calls'); bus.activity('Discovery call booked', tag); }
  else if (triggerEvent === 'BOOKING_CANCELLED' && metrics.discovery_calls > 0) { bus.bumpMetric('discovery_calls', -1); }
  res.json({ ok: true });
});

/* ===========================  HubSpot adapter  ============================ */
// Free CRM has no workflow webhooks, so we poll the Search API (read-only).
async function hsCount(object, filters) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${object}/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CFG.hubspotToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filterGroups: [{ filters }], limit: 1 }),
  });
  if (!r.ok) throw new Error(`HubSpot ${object} search ${r.status}`);
  return (await r.json()).total || 0;
}
async function pollHubSpot() {
  try {
    const now = Date.now();
    // leads: contacts created in the trailing 30 days; week_total: trailing 7 days
    const leads = await hsCount('contacts', [{ propertyName: 'createdate', operator: 'GTE', value: now - 30 * DAY }]);
    const week  = await hsCount('contacts', [{ propertyName: 'createdate', operator: 'GTE', value: now - 7 * DAY }]);
    bus.setMetric('leads', leads);
    bus.setMetric('week_total', week);
    // engagements: deals sitting in the configured "active engagement" stage
    if (CFG.engagementStage) {
      const eng = await hsCount('deals', [{ propertyName: 'dealstage', operator: 'EQ', value: CFG.engagementStage }]);
      bus.setMetric('engagements', eng);
    }
    // history: contacts created per day for the last 7 days (oldest -> newest)
    const hist = [];
    for (let i = 6; i >= 0; i--) {
      const start = now - (i + 1) * DAY, end = now - i * DAY;
      hist.push(await hsCount('contacts', [
        { propertyName: 'createdate', operator: 'GTE', value: start },
        { propertyName: 'createdate', operator: 'LT',  value: end },
      ]));
    }
    bus.setHistory(hist);
  } catch (e) { console.error('[hubspot]', e.message, '(keeping last values)'); }
}

/* ==========================  Plausible adapter  =========================== */
async function plausibleRealtime() {
  const r = await fetch(`${CFG.plausibleHost}/api/v1/stats/realtime/visitors?site_id=${encodeURIComponent(CFG.plausibleSite)}`,
    { headers: { Authorization: `Bearer ${CFG.plausibleKey}` } });
  if (!r.ok) throw new Error(`Plausible realtime ${r.status}`);
  return await r.json(); // a bare number
}
async function plausibleToday() {
  const u = `${CFG.plausibleHost}/api/v1/stats/aggregate?site_id=${encodeURIComponent(CFG.plausibleSite)}&period=day&metrics=visits`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${CFG.plausibleKey}` } });
  if (!r.ok) throw new Error(`Plausible aggregate ${r.status}`);
  const j = await r.json();
  return (j.results && j.results.visits && j.results.visits.value) || 0;
}
async function pollLive()  { try { bus.setMetric('sessions_live',  await plausibleRealtime()); } catch (e) { console.error('[plausible live]', e.message); } }
async function pollToday() { try { bus.setMetric('sessions_today', await plausibleToday());    } catch (e) { console.error('[plausible today]', e.message); } }

/* ------------------------------- simulator ------------------------------- */
const sim = {
  start({ includeDiscovery }) {
    const rnd = (n) => Math.floor(Math.random() * n);
    if (metrics.sessions_live === 0) { metrics.sessions_live = 7; metrics.sessions_today = 212; metrics.leads = 38; metrics.engagements = 5; metrics.week_total = 11; metrics.history = [4,6,5,8,7,9,11]; }
    setInterval(() => bus.setMetric('sessions_live', Math.max(2, metrics.sessions_live + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.3 ? 2 : 1))), 4200);
    setInterval(() => {
      const r = Math.random(), tag = TAGS[rnd(TAGS.length)];
      bus.bumpMetric('sessions_today', rnd(3) + 1);
      if (r < 0.34) { bus.bumpMetric('leads'); bus.bumpMetric('week_total'); bus.pushHistoryPoint((metrics.history.at(-1) || 0) + 1); bus.activity('New inquiry · capability fit', tag); }
      else if (includeDiscovery && r < 0.50) { bus.bumpMetric('discovery_calls'); bus.activity('Discovery call booked', tag); }
      else { bus.activity('Capability statement downloaded', tag); }
    }, 7000);
  },
};

/* --------------------------------- boot ---------------------------------- */
function boot() {
  if (CFG.source === 'simulated') { sim.start({ includeDiscovery: true }); return; }
  if (CFG.source === 'cal')       { sim.start({ includeDiscovery: false }); console.log('[woldt-metrics] CAL mode — discovery_calls live via /webhooks/cal'); return; }

  // live
  console.log('[woldt-metrics] LIVE mode');
  if (!CFG.calSecret) console.log('  ! CAL_WEBHOOK_SECRET not set — webhook signature check is OFF');
  if (CFG.hubspotToken) { pollHubSpot(); setInterval(pollHubSpot, CFG.pollCrmMs); console.log('  + HubSpot polling (leads, week_total, engagements, history)'); }
  else console.log('  - HubSpot skipped (set HUBSPOT_TOKEN to enable leads/engagements)');
  if (CFG.plausibleKey && CFG.plausibleSite) {
    pollLive(); setInterval(pollLive, CFG.pollLiveMs);
    pollToday(); setInterval(pollToday, CFG.pollTodayMs);
    console.log('  + Plausible polling (sessions_live, sessions_today)');
  } else console.log('  - Plausible skipped (set PLAUSIBLE_API_KEY + PLAUSIBLE_SITE_ID to enable sessions)');
  if (!CFG.engagementStage) console.log('  ! HUBSPOT_ENGAGEMENT_STAGE not set — engagements will stay 0');
}

app.listen(CFG.port, () => { console.log(`[woldt-metrics] listening on http://localhost:${CFG.port}  (source: ${CFG.source})`); boot(); });
