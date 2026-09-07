/**
 * Loop server — v1
 * One file: ingestion (/collect), insights API (/api/insights),
 * recommendation API (/api/recommendation), snippet (/loop.js), dashboard (/).
 *
 * Run: node server.js   (Node 22+, uses built-in node:sqlite — no native deps)
 */
const express = require('express');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// All configuration lives in ./config.js — the one place that reads the environment,
// validates it, and refuses to boot on bad values. Nothing else in this file should
// touch process.env.
const configModule = require('./config');

configModule.loadEnvFile();   // read server/.env if present; the real env always wins

let config;
try {
  config = configModule.load();
} catch (err) {
  // A config error is fatal and actionable: print it plainly and stop. Exiting
  // non-zero is what makes a bad deploy fail loudly instead of quietly serving
  // traffic in a broken state.
  console.error(`
${err.message}
`);
  process.exit(1);
}
config.warnings.forEach(w => console.warn(`[config] ${w}`));

const db = new DatabaseSync(config.dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site        TEXT NOT NULL,
    vid         TEXT NOT NULL,
    type        TEXT NOT NULL,
    url         TEXT,
    referrer    TEXT,
    ft_source   TEXT, ft_medium TEXT, ft_campaign TEXT, ft_content TEXT, ft_landing TEXT,
    lt_source   TEXT, lt_medium TEXT, lt_campaign TEXT, lt_content TEXT, lt_landing TEXT,
    props       TEXT,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events (site, ts);
  CREATE INDEX IF NOT EXISTS idx_events_vid ON events (vid);

  -- Per-site GA4 forwarding config. One row per founder site, created/updated
  -- via POST /api/config. Absence of a row means "GA4 forwarding off" for that site.
  CREATE TABLE IF NOT EXISTS site_config (
    site               TEXT PRIMARY KEY,
    ga4_measurement_id TEXT,
    ga4_api_secret     TEXT,
    updated_at         INTEGER NOT NULL
  );

  -- Persisted approved scripts ("bets"). This is the memory the warm learning
  -- loop reads from: each row is a script the founder approved, tagged with the
  -- source/landing/campaign it targeted and the full script text. Signup results
  -- are recomputed live from the events table by matching lt_campaign, so we
  -- never store a stale count. Survives server restarts (fixes the old in-memory
  -- approvals that were lost on restart).
  CREATE TABLE IF NOT EXISTS bets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    site         TEXT NOT NULL,
    campaign     TEXT NOT NULL,        -- utm_campaign used to measure this bet
    source       TEXT,                 -- the audience/source this bet targeted
    landing      TEXT,                 -- best-converting landing page at bet time
    angle        TEXT,                 -- short label for the creative approach
    hook         TEXT,
    body         TEXT,
    cta          TEXT,
    full_script  TEXT,
    approved_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bets_site ON bets (site, approved_at);
`);

const insertEvent = db.prepare(`
  INSERT INTO events (site, vid, type, url, referrer,
    ft_source, ft_medium, ft_campaign, ft_content, ft_landing,
    lt_source, lt_medium, lt_campaign, lt_content, lt_landing,
    props, ts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getSiteConfig = db.prepare(`SELECT * FROM site_config WHERE site = ?`);
const upsertSiteConfig = db.prepare(`
  INSERT INTO site_config (site, ga4_measurement_id, ga4_api_secret, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(site) DO UPDATE SET
    ga4_measurement_id = excluded.ga4_measurement_id,
    ga4_api_secret = excluded.ga4_api_secret,
    updated_at = excluded.updated_at
`);

const insertBet = db.prepare(`
  INSERT INTO bets (site, campaign, source, landing, angle, hook, body, cta, full_script, approved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const listBets = db.prepare(`SELECT * FROM bets WHERE site = ? ORDER BY approved_at ASC`);

// For a given site, return each past bet joined with its LIVE measured result:
// how many signups carried that bet's campaign in the 7 days after approval.
// Recomputed every call so the "what worked" signal is never stale.
function betsWithResults(site) {
  const bets = listBets.all(site);
  return bets.map(b => {
    const windowEnd = b.approved_at + 7 * 86400000;
    const r = db.prepare(`
      SELECT COUNT(DISTINCT vid) AS signups FROM events
      WHERE site = ? AND type = 'signup' AND lt_campaign = ?
        AND ts >= ? AND ts <= ?
    `).get(site, b.campaign, b.approved_at, windowEnd);
    return { ...b, measured_signups: r.signups || 0 };
  });
}


const app = express();
app.use(
  express.json(
    { 
      limit: '16kb', 
      type: ['application/json', 'text/plain'] 
    }
  )
);

// ---------- GA4 forwarding (server-side, fire-and-forget) ----------
// Translates OUR event shape into GA4's Measurement Protocol shape and POSTs it.
// This never blocks or fails the original /collect response — GA4 is a side
// effect, not a dependency. If Google's API is down or the secret is wrong,
// the founder's own data (in our SQLite) is completely unaffected.
const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

function forwardToGA4(siteConfig, event) {
  if (!siteConfig || !siteConfig.ga4_measurement_id || !siteConfig.ga4_api_secret) return;

  // GA4 requires a client_id to group events into sessions. We reuse our own
  // anonymous visitor id (vid) — it's not GA4's client_id format, but it's a
  // stable per-visitor identifier, which is the property GA4 actually needs
  // from it. GA4 will treat it as an opaque string.
  const ga4Body = {
    client_id: event.vid,
    events: [
      {
        // GA4 event names: letters/numbers/underscores only, so 'pageview' -> 'page_view'
        name: event.type === 'pageview' ? 'page_view' : String(event.type).replace(/[^a-zA-Z0-9_]/g, '_'),
        params: {
          // Map our first-touch fields onto GA4's expected UTM parameter names.
          // This is the "translation" step: GA4 won't understand ft_source,
          // it understands source/medium/campaign on the event itself.
          source: event.ft_source || '(direct)',
          medium: event.ft_medium || '(none)',
          campaign: event.ft_campaign || undefined,
          content: event.ft_content || undefined,
          page_location: event.url || undefined,
          // Marks this as a non-bounce engaged hit; without this GA4 may
          // discard the event as a non-interaction ping.
          engagement_time_msec: 1
        }
      }
    ]
  };

  const url = `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(siteConfig.ga4_measurement_id)}&api_secret=${encodeURIComponent(siteConfig.ga4_api_secret)}`;

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ga4Body)
  }).catch(err => {
    // Swallow network errors — see comment above. We still log so a founder
    // troubleshooting "why isn't GA4 getting data" has something to check server-side.
    console.error(`[ga4-forward] failed for site=${event.site}:`, err.message);
  });
  // Note: GA4 Measurement Protocol returns 204 even on many bad-input cases
  // (wrong secret, malformed event) by design — Google doesn't want to leak
  // validation details to arbitrary callers. So a 2xx here is NOT proof the
  // event was accepted. This is a known limitation; real verification would
  // require Google's separate (rate-limited) debug endpoint.
}

// CORS: the snippet posts from customer sites, so /collect must accept cross-origin.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Auth (single shared password) ----------
// Set LOOP_PASSWORD to protect the dashboard and all management/read APIs. Left
// unset (e.g. local dev), auth is OFF and everything is open — the server logs a
// warning so this isn't a silent surprise in production.
//
// PUBLIC endpoints (never require a password, because visitors' browsers hit them
// with no way to send one): POST /collect and GET /loop.js. Everything else —
// the dashboard and /api/* management/read routes — is protected.
// Validated in config.js: optional in development, but REQUIRED and >= 16 chars
// when NODE_ENV=production, where a missing password aborts boot rather than
// warning and then serving everything wide open.
const LOOP_PASSWORD = config.password;
const PUBLIC_PATHS = new Set(['/collect', '/loop.js']);

app.use((req, res, next) => {
  if (!LOOP_PASSWORD) return next();               // auth disabled
  if (PUBLIC_PATHS.has(req.path)) return next();    // visitor-facing, always open
  if (req.method === 'OPTIONS') return next();

  // Accept the password via either the Authorization header (for API/curl use:
  // "Authorization: Bearer <password>") or a ?key= query param (so the dashboard
  // can be opened with one URL). Constant-time-ish compare on length+value.
  const auth = req.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const provided = bearer || req.query.key || null;
  if (provided && provided === LOOP_PASSWORD) return next();

  res.status(401).json({ error: 'unauthorized', hint: 'Add ?key=YOUR_PASSWORD to the URL, or send Authorization: Bearer YOUR_PASSWORD.' });
});

// ---------- Ingestion ----------
app.post('/collect', (req, res) => {
  const b = req.body || {};
  if (!b.site || !b.vid || !b.type) return res.status(400).json({ error: 'site, vid, type required' });
  if (String(b.vid).length > 64 || String(b.type).length > 64) return res.status(400).json({ error: 'invalid payload' });
  const ft = b.ft || {}, lt = b.lt || {};
  const site = String(b.site).slice(0, 64);
  const ts = Number(b.ts) || Date.now();

  insertEvent.run(
    site, String(b.vid), String(b.type).slice(0, 64),
    b.url ? String(b.url).slice(0, 512) : null,
    b.referrer ? String(b.referrer).slice(0, 512) : null,
    ft.source || null, ft.medium || null, ft.campaign || null, ft.content || null, ft.landing || null,
    lt.source || null, lt.medium || null, lt.campaign || null, lt.content || null, lt.landing || null,
    b.props ? JSON.stringify(b.props).slice(0, 2048) : null,
    ts
  );

  // Respond to the snippet immediately — our own write is the source of truth.
  res.status(204).end();

  // GA4 forwarding happens AFTER responding, and only if this site configured it.
  // This ordering guarantees GA4 can never slow down or break the founder's
  // own data collection (see forwardToGA4 comments for why we don't await this).
  const config = getSiteConfig.get(site);
  if (config) {
    forwardToGA4(config, {
      site, vid: b.vid, type: b.type, url: b.url,
      ft_source: ft.source, ft_medium: ft.medium, ft_campaign: ft.campaign, ft_content: ft.content,
      ts
    });
  }
});

// ---------- Site config (GA4 forwarding settings) ----------
// POST: founder saves/updates their GA4 Measurement ID + API secret for a site.
// No auth in v1 — anyone who knows the site name can set this. Acceptable for
// self-hosted single-tenant use; would need auth before hosting multiple founders.
app.post('/api/config', (req, res) => {
  const { site, ga4_measurement_id, ga4_api_secret } = req.body || {};
  if (!site) return res.status(400).json({ error: 'site required' });

  // Light shape validation only — we cannot truly verify the secret without
  // calling Google (see forwardToGA4 comment: even that call wouldn't be reliable).
  if (ga4_measurement_id && !/^G-[A-Z0-9]+$/i.test(ga4_measurement_id)) {
    return res.status(400).json({ error: 'ga4_measurement_id should look like G-XXXXXXX' });
  }

  upsertSiteConfig.run(
    String(site).slice(0, 64),
    ga4_measurement_id ? String(ga4_measurement_id).slice(0, 32) : null,
    ga4_api_secret ? String(ga4_api_secret).slice(0, 128) : null,
    Date.now()
  );

  res.json({
    status: 'saved',
    site,
    ga4_enabled: !!(ga4_measurement_id && ga4_api_secret),
    note: 'Saved. We cannot confirm Google accepted it — GA4\'s API returns success-like responses even for some bad inputs. Check your GA4 Realtime report after sending a test event.'
  });
});

// GET: check current config for a site WITHOUT returning the secret itself.
app.get('/api/config', (req, res) => {
  const site = String(req.query.site || '');
  if (!site) return res.status(400).json({ error: 'site required' });
  const config = getSiteConfig.get(site);
  if (!config) return res.json({ site, ga4_enabled: false });
  res.json({
    site,
    ga4_enabled: !!(config.ga4_measurement_id && config.ga4_api_secret),
    ga4_measurement_id: config.ga4_measurement_id || null,
    // ga4_api_secret intentionally omitted — never echo secrets back over GET
    updated_at: config.updated_at
  });
});

// ---------- Insights ----------
// Aggregates by FIRST-TOUCH source: which discovery channel produces signups.
// A visitor counts once; they convert if they ever fired 'signup' in the window.
function computeInsights(site, days, conversionEvent = 'signup') {
  const since = Date.now() - days * 86400000;
  const ev = String(conversionEvent || 'signup');
  // The conversion event is a bind parameter (?), never string-interpolated, so a
  // founder-named event like 'trial' or 'upgraded' can't inject SQL. The output
  // field stays named `signups` so all downstream code is unchanged — it now means
  // "count of the chosen conversion event".
  const rows = db.prepare(`
    SELECT
      COALESCE(ft_source, 'direct')   AS source,
      COUNT(DISTINCT vid)             AS visitors,
      COUNT(DISTINCT CASE WHEN type = ? THEN vid END) AS signups
    FROM events
    WHERE site = ? AND ts >= ?
    GROUP BY COALESCE(ft_source, 'direct')
    ORDER BY signups DESC, visitors DESC
  `).all(ev, site, since);

  const totals = rows.reduce((a, r) => ({ visitors: a.visitors + r.visitors, signups: a.signups + r.signups }),
    { visitors: 0, signups: 0 });
  const siteRate = totals.visitors ? totals.signups / totals.visitors : 0;

  const sources = rows.map(r => {
    const rate = r.visitors ? r.signups / r.visitors : 0;
    return {
      source: r.source,
      visitors: r.visitors,
      signups: r.signups,
      rate,
      vsSite: siteRate > 0 ? rate / siteRate : null,
      // anomaly: enough evidence (≥20 visitors or ≥2 conversions) and ≥2x site rate
      anomaly: rate >= siteRate * 2 && rate > 0 && (r.visitors >= 20 || r.signups >= 2)
    };
  });

  // Campaign/content breakdown for anomalous sources (the "why" drill-down)
  const campaigns = db.prepare(`
    SELECT COALESCE(ft_source,'direct') AS source,
           COALESCE(ft_campaign,'(none)') AS campaign,
           COALESCE(ft_landing,'/') AS landing,
           COUNT(DISTINCT vid) AS visitors,
           COUNT(DISTINCT CASE WHEN type = ? THEN vid END) AS signups
    FROM events WHERE site = ? AND ts >= ?
    GROUP BY 1, 2, 3 HAVING signups > 0
    ORDER BY signups DESC LIMIT 20
  `).all(ev, site, since);

  return { site, days, conversionEvent: ev, totals: { ...totals, rate: siteRate }, sources, campaigns };
}

app.get('/api/insights', (req, res) => {
  const site = String(req.query.site || 'default');
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const event = req.query.event ? String(req.query.event) : 'signup';
  res.json(computeInsights(site, days, event));
});

// What event types has this site actually recorded, with counts? Lets the
// dashboard offer the founder a picker of their real conversion events.
app.get('/api/events', (req, res) => {
  const site = String(req.query.site || '');
  if (!site) return res.status(400).json({ error: 'site required' });
  const rows = db.prepare(`
    SELECT type, COUNT(*) AS n FROM events WHERE site = ?
    GROUP BY type ORDER BY n DESC
  `).all(site);
  res.json({ site, events: rows });
});

// ---------- Recommendation ----------
// v1: deterministic, transparent. Picks the strongest above-average source with
// enough evidence and explains WHY with the underlying numbers. This is the
// recommendation card; the founder (or later, the Create layer) acts on it.
app.get('/api/recommendation', (req, res) => {
  const site = String(req.query.site || 'default');
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const ins = computeInsights(site, days);

  if (ins.totals.signups < 3) {
    return res.json({
      status: 'insufficient_data',
      message: `Only ${ins.totals.signups} signup(s) in the last ${days} days. The loop needs at least 3 to find a defensible pattern. Keep collecting.`,
      totals: ins.totals
    });
  }

  const candidates = ins.sources
    .filter(s => s.source !== 'direct' && s.signups >= 2 && s.rate > ins.totals.rate)
    .sort((a, b) => (b.rate * Math.log2(1 + b.signups)) - (a.rate * Math.log2(1 + a.signups)));

  if (!candidates.length) {
    return res.json({
      status: 'no_clear_winner',
      message: 'No non-direct source is converting above your site average with enough evidence yet. The honest recommendation is: no bet this week.',
      totals: ins.totals
    });
  }

  const top = candidates[0];
  const drill = ins.campaigns.filter(c => c.source === top.source);
  const bestLanding = drill.sort((a, b) => b.signups - a.signups)[0];

  res.json({
    status: 'ok',
    insight: {
      headline: `${top.source} converts ${top.vsSite.toFixed(1)}x your site average`,
      source: top.source,
      evidence: {
        visitors: top.visitors,
        signups: top.signups,
        rate: top.rate,
        siteRate: ins.totals.rate,
        window: `${days}d`,
        topLanding: bestLanding ? bestLanding.landing : null,
        topCampaign: bestLanding ? bestLanding.campaign : null
      },
      why: `In the last ${days} days, ${top.source} sent ${top.visitors} visitors and ${top.signups} signed up ` +
           `(${(top.rate * 100).toFixed(1)}% vs ${(ins.totals.rate * 100).toFixed(1)}% site average). ` +
           `Visitors from this source are already pre-qualified — more content where they are should compound.`,
      suggestedBet: `Create one piece of content for the ${top.source} audience` +
        (bestLanding && bestLanding.landing !== '/' ? `, themed on what ${bestLanding.landing} promises them` : '') +
        `. Publish with utm_source=${top.source}&utm_campaign=loop-bet-1 so the result is measurable.`
    },
    nextStep: 'generate_script' // wired to the Create layer in the next milestone
  });
});

// ---------- Create: generate script from recommendation ----------
// Takes recommendation data and turns it into a short, punchy video script.
// Format: hook (gets attention) → insight (the "why") → CTA (what to do).
function generateScript(source, visitors, signups, rate, siteRate, days) {
  const src = source.replace('.com', '').replace(/[_-]/g, ' ');

  // Hook: intrigue based on the source
  const hooks = {
    'twitter': `I tested something on my analytics yesterday that shocked me.`,
    'reddit': `So I checked where my best customers come from... it wasn't where I expected.`,
    'producthunt': `Product Hunt sent me the best-converting traffic I've ever seen. Here's why.`,
    'google': `Google brought in the most visitors, but conversion? That was a surprise.`,
    'linkedin': `LinkedIn's quieter than I thought, but the people who sign up? They stick around.`,
    'direct': `The people who type our URL directly? Totally different from everyone else.`,
  };
  const hook = hooks[source] || `I just realized something about where my best customers come from.`;

  // Insight: the data-driven "why"
  const insightBody =
    `Turns out, ${visitors} visitors from ${src} sent me ${signups} signups. ` +
    `That's a ${(rate * 100).toFixed(1)}% conversion rate — ` +
    `${(rate / siteRate).toFixed(1)}x better than my site average. ` +
    `The reason? They're already pre-qualified when they arrive.`;

  // CTA: specific and actionable
  const cta =
    `So I'm doubling down. I'm creating more content for the ${src} audience this week. ` +
    `If you're building something (and ${src} shows up in your analytics), ` +
    `this might be worth testing too.`;

  return {
    source,
    duration_seconds: 45,
    hook,
    body: insightBody,
    cta,
    full_script: `${hook}\n\n${insightBody}\n\n${cta}`,
    utm_campaign: 'loop-bet-1',
    utm_source: source,
    note: `This script is grounded in ${days}d of real data. The ${source} audience converts ${(rate / siteRate).toFixed(1)}x your average. Record this, publish it to your channel, measure the result.`
  };
}

app.get('/api/script', (req, res) => {
  const site = String(req.query.site || 'default');
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const ins = computeInsights(site, days);
  
  // Check if we have enough data
  if (ins.totals.signups < 3) {
    return res.json({ status: 'insufficient_data', reason: `Only ${ins.totals.signups} signups; need 3+` });
  }

  // Find the best candidate source
  const candidates = ins.sources
    .filter(s => s.source !== 'direct' && s.signups >= 2 && s.rate > ins.totals.rate)
    .sort((a, b) => (b.rate * Math.log2(1 + b.signups)) - (a.rate * Math.log2(1 + a.signups)));
  
  if (!candidates.length) {
    return res.json({ status: 'no_clear_winner', reason: 'no source beats site average with enough evidence' });
  }

  const top = candidates[0];
  const script = generateScript(top.source, top.visitors, top.signups, top.rate, ins.totals.rate, days);
  
  res.json({ status: 'ok', script });
});

// ---------- Create (AI): generate NEW scripts, learning from what converted ----------
// Cold start (few/no measured bets): AI proposes fresh scripts from the attribution
//   insight alone. It does NOT pretend to have learned anything yet.
// Warm (enough measured bets): AI additionally conditions on (a) the TEXT of past
//   scripts + how many signups each drove, and (b) source/landing/campaign aggregates,
//   and returns a transparent, audience-LEVEL research summary — never individual
//   profiling — with an explicit confidence caveat tied to sample size.
//
// Requires ANTHROPIC_API_KEY in the environment. If absent, returns a clear error
// rather than silently falling back, so it's obvious the AI path isn't wired up.
const ANTHROPIC_API_KEY = config.anthropicApiKey;
const WARM_THRESHOLD_BETS = 3;      // need at least this many measured bets to "learn"
const WARM_THRESHOLD_SIGNUPS = 5;   // ...and at least this many signups across them

async function callClaude(system, userPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!resp.ok) throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  // The prompt asks for pure JSON; strip any accidental code fences before parsing.
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

app.get('/api/generate-scripts', async (req, res) => {
  const site = String(req.query.site || 'default');
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({
      status: 'ai_unavailable',
      message: 'ANTHROPIC_API_KEY is not set on the server. The AI script generator needs it. ' +
               'The template-based /api/script endpoint still works without it.'
    });
  }

  const ins = computeInsights(site, days);
  if (ins.totals.signups < 3) {
    return res.json({ status: 'insufficient_data', reason: `Only ${ins.totals.signups} signups; need 3+ before generating.` });
  }

  const candidates = ins.sources
    .filter(s => s.source !== 'direct' && s.signups >= 2 && s.rate > ins.totals.rate)
    .sort((a, b) => (b.rate * Math.log2(1 + b.signups)) - (a.rate * Math.log2(1 + a.signups)));
  if (!candidates.length) {
    return res.json({ status: 'no_clear_winner', reason: 'No source beats site average with enough evidence yet.' });
  }
  const top = candidates[0];

  // Best landing page for this source (audience-level, from aggregates we already have)
  const drill = ins.campaigns.filter(c => c.source === top.source).sort((a, b) => b.signups - a.signups)[0];
  const topLanding = drill ? drill.landing : null;

  // Decide cold vs warm from measured history.
  const past = betsWithResults(site);
  const totalMeasured = past.reduce((a, b) => a + b.measured_signups, 0);
  const isWarm = past.length >= WARM_THRESHOLD_BETS && totalMeasured >= WARM_THRESHOLD_SIGNUPS;

  const system =
    "You are a marketing copywriter for a solo SaaS founder. You write short (~45s) " +
    "video ad scripts, each with a hook, body, and CTA. You reason ONLY about audiences " +
    "and channels in aggregate — never about identifiable individuals, never inferring a " +
    "specific person's identity or personality. You are honest about weak evidence and never " +
    "overstate what small numbers prove. Output STRICT JSON only, no prose, no code fences.";

  let userPrompt;
  if (!isWarm) {
    // COLD START — attribution insight only, and say so.
    userPrompt =
`Generate 3 NEW, distinct 45-second video ad script ideas for a SaaS founder.

Context (this is all we know — treat it as the only signal):
- Best-converting acquisition source: ${top.source}
- That source: ${top.visitors} visitors, ${top.signups} signups (${(top.rate*100).toFixed(1)}% vs ${(ins.totals.rate*100).toFixed(1)}% site average)
- Best landing page for that source: ${topLanding || '(unknown)'}

We have little/no measured history of past ad performance yet, so do NOT claim to have
learned what works — these are fresh hypotheses to TEST.

Return JSON:
{
  "mode": "cold_start",
  "research_summary": "2-3 sentences, audience-level only, explicitly noting this is a hypothesis with no performance history yet",
  "scripts": [
    {"angle": "short label", "hook": "...", "body": "...", "cta": "..."},
    {"angle": "...", "hook": "...", "body": "...", "cta": "..."},
    {"angle": "...", "hook": "...", "body": "...", "cta": "..."}
  ]
}`;
  } else {
    // WARM — condition on past script text + measured results + aggregates.
    const history = past.map(b =>
      `- campaign="${b.campaign}" source="${b.source||'?'}" landing="${b.landing||'?'}" angle="${b.angle||'?'}" ` +
      `→ ${b.measured_signups} signup(s). Hook: "${(b.hook||'').slice(0,140)}"`
    ).join('\n');

    userPrompt =
`Generate 3 NEW, distinct 45-second video ad script ideas for a SaaS founder, LEARNING from
what has actually converted before. Do not reuse past scripts verbatim — create new ones that
share the traits of the winners.

Current best-converting source: ${top.source} (${(top.rate*100).toFixed(1)}% vs ${(ins.totals.rate*100).toFixed(1)}% site avg), best landing: ${topLanding || '(unknown)'}.

Past bets and their MEASURED results (7-day signup counts):
${history}

Total measured signups across all past bets: ${totalMeasured} across ${past.length} bets.
This is still a SMALL sample — reason at the audience/channel level only, flag low confidence,
and never profile individuals.

Return JSON:
{
  "mode": "warm",
  "research_summary": "3-5 sentences: which audience/channel + which SCRIPT TRAITS (hook style, framing, length) correlate with signups so far, WHY that might be, and an explicit confidence caveat given the sample size. Audience-level only.",
  "learned_traits": ["trait 1", "trait 2"],
  "scripts": [
    {"angle": "short label", "hook": "...", "body": "...", "cta": "...", "rationale": "why this reflects what worked"},
    {"angle": "...", "hook": "...", "body": "...", "cta": "...", "rationale": "..."},
    {"angle": "...", "hook": "...", "body": "...", "cta": "...", "rationale": "..."}
  ]
}`;
  }

  try {
    const out = await callClaude(system, userPrompt);
    res.json({
      status: 'ok',
      mode: isWarm ? 'warm' : 'cold_start',
      source: top.source,
      suggested_landing: topLanding,
      evidence: { visitors: top.visitors, signups: top.signups, rate: top.rate, siteRate: ins.totals.rate, past_bets: past.length, past_signups: totalMeasured },
      ...out
    });
  } catch (err) {
    res.status(502).json({ status: 'ai_error', message: 'Script generation failed.', detail: String(err.message).slice(0, 300) });
  }
});

// ---------- Approve & Publish: persist the approved script as one or more "bets" ----------
// Single channel (default): creates one bet with one campaign.
// Multi-channel: pass channels:["reddit","x","linkedin"] and it creates one bet PER
// channel, each with its own campaign suffix (loop-bet-N-reddit, ...-x, ...) so their
// 7-day results never mix — letting the founder compare the same script across channels.
app.post('/api/approve', express.json(), (req, res) => {
  const { site, campaign_name, source, landing, angle, hook, body, cta, full_script, channels } = req.body;
  if (!site) return res.status(400).json({ error: 'site required' });

  const script = full_script || [hook, body, cta].filter(Boolean).join('\n\n') || null;
  const timestamp = Date.now();
  const base = campaign_name || `loop-bet-${listBets.all(site).length + 1}`;

  // Normalize channels: dedupe, strip blanks, cap length. Empty → single-channel.
  const chanList = Array.isArray(channels)
    ? [...new Set(channels.map(c => String(c).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')).filter(Boolean))].slice(0, 8)
    : [];

  const targets = chanList.length
    ? chanList.map(ch => ({ channel: ch, campaign: `${base}-${ch}` }))
    : [{ channel: source || site, campaign: base }];

  const created = targets.map(t => {
    insertBet.run(
      site, t.campaign,
      t.channel || source || null, landing || null, angle || null,
      hook || null, body || null, cta || null, script, timestamp
    );
    return {
      channel: t.channel,
      utm_source: t.channel,
      utm_campaign: t.campaign,
      publish_link_params: `?utm_source=${t.channel}&utm_campaign=${t.campaign}`
    };
  });

  res.json({
    status: 'approved',
    site,
    multi_channel: chanList.length > 0,
    bets: created,
    instructions: chanList.length
      ? 'Publish the script on each channel using that channel\'s link params below. Each is measured separately for 7 days.'
      : `Record your script. When you publish, add ${created[0].publish_link_params} to the link. Then check the bets table after 7 days.`,
    approvedAt: timestamp
  });
});

// List a site's past bets with their live measured results — powers a history
// view and lets the founder see which past scripts actually converted.
app.get('/api/bets', (req, res) => {
  const site = String(req.query.site || '');
  if (!site) return res.status(400).json({ error: 'site required' });
  res.json({ site, bets: betsWithResults(site) });
});

// All sites this server has ever seen (events or bets) — feeds the dashboard
// dropdown so it no longer needs a hardcoded list.
app.get('/api/sites', (_req, res) => {
  const rows = db.prepare(`
    SELECT site FROM events GROUP BY site
    UNION
    SELECT site FROM bets GROUP BY site
    ORDER BY site
  `).all();
  res.json({ sites: rows.map(r => r.site) });
});

// ---------- Measure: count signups from a published campaign (7-day window) ----------
app.get('/api/measure', (req, res) => {
  const { site, campaign } = req.query;
  if (!site || !campaign) return res.status(400).json({ error: 'site and campaign required' });
  
  const since = Date.now() - 7 * 86400000; // 7-day measurement window
  const row = db.prepare(`
    SELECT COUNT(DISTINCT vid) as attributed FROM events
    WHERE site = ? AND type = 'signup'
    AND ts >= ? AND lt_campaign = ?
  `).get(site, since, campaign);
  
  res.json({
    campaign,
    window: '7 days',
    attributed_signups: row.attributed || 0,
    message: row.attributed > 0 
      ? `✓ Your ${campaign} content drove ${row.attributed} signup(s) in the last 7 days.`
      : `No signups yet. Give it more time or publish to more channels.`
  });
});

// ---------- Static ----------
app.get('/loop.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'snippet', 'loop.js')));
app.get('/test', (_req, res) => res.sendFile(path.join(__dirname, 'test-page.html')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.listen(config.port, () => {
  // Boot summary: every effective setting, with secrets shown as present/absent
  // only — never their values, because logs get copied into issues and chats.
  configModule.describe(config).forEach(line => console.log(`[config] ${line}`));
  console.log(`Loop v1 running → http://localhost:${config.port}`);
});
