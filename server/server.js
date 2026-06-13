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

const PORT = process.env.PORT || 4070;
const DB_PATH = process.env.LOOP_DB || path.join(__dirname, 'loop.db');

const db = new DatabaseSync(DB_PATH);
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
`);

const insertEvent = db.prepare(`
  INSERT INTO events (site, vid, type, url, referrer,
    ft_source, ft_medium, ft_campaign, ft_content, ft_landing,
    lt_source, lt_medium, lt_campaign, lt_content, lt_landing,
    props, ts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const app = express();
app.use(express.json({ limit: '16kb', type: ['application/json', 'text/plain'] }));

// CORS: the snippet posts from customer sites, so /collect must accept cross-origin.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Ingestion ----------
app.post('/collect', (req, res) => {
  const b = req.body || {};
  if (!b.site || !b.vid || !b.type) return res.status(400).json({ error: 'site, vid, type required' });
  if (String(b.vid).length > 64 || String(b.type).length > 64) return res.status(400).json({ error: 'invalid payload' });
  const ft = b.ft || {}, lt = b.lt || {};
  insertEvent.run(
    String(b.site).slice(0, 64), String(b.vid), String(b.type).slice(0, 64),
    b.url ? String(b.url).slice(0, 512) : null,
    b.referrer ? String(b.referrer).slice(0, 512) : null,
    ft.source || null, ft.medium || null, ft.campaign || null, ft.content || null, ft.landing || null,
    lt.source || null, lt.medium || null, lt.campaign || null, lt.content || null, lt.landing || null,
    b.props ? JSON.stringify(b.props).slice(0, 2048) : null,
    Number(b.ts) || Date.now()
  );
  res.status(204).end();
});

// ---------- Insights ----------
// Aggregates by FIRST-TOUCH source: which discovery channel produces signups.
// A visitor counts once; they convert if they ever fired 'signup' in the window.
function computeInsights(site, days) {
  const since = Date.now() - days * 86400000;
  const rows = db.prepare(`
    SELECT
      COALESCE(ft_source, 'direct')   AS source,
      COUNT(DISTINCT vid)             AS visitors,
      COUNT(DISTINCT CASE WHEN type = 'signup' THEN vid END) AS signups
    FROM events
    WHERE site = ? AND ts >= ?
    GROUP BY COALESCE(ft_source, 'direct')
    ORDER BY signups DESC, visitors DESC
  `).all(site, since);

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
      // anomaly: enough evidence (≥20 visitors or ≥2 signups) and ≥2x site rate
      anomaly: rate >= siteRate * 2 && rate > 0 && (r.visitors >= 20 || r.signups >= 2)
    };
  });

  // Campaign/content breakdown for anomalous sources (the "why" drill-down)
  const campaigns = db.prepare(`
    SELECT COALESCE(ft_source,'direct') AS source,
           COALESCE(ft_campaign,'(none)') AS campaign,
           COALESCE(ft_landing,'/') AS landing,
           COUNT(DISTINCT vid) AS visitors,
           COUNT(DISTINCT CASE WHEN type='signup' THEN vid END) AS signups
    FROM events WHERE site = ? AND ts >= ?
    GROUP BY 1, 2, 3 HAVING signups > 0
    ORDER BY signups DESC LIMIT 20
  `).all(site, since);

  return { site, days, totals: { ...totals, rate: siteRate }, sources, campaigns };
}

app.get('/api/insights', (req, res) => {
  const site = String(req.query.site || 'default');
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  res.json(computeInsights(site, days));
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

// ---------- Approve & Publish: save approval and track the bet ----------
// In v1, approvals are ephemeral (in-memory). In production, these would be persisted.
const approvals = {};

app.post('/api/approve', express.json(), (req, res) => {
  const { site, days, campaign_name } = req.body;
  if (!site) return res.status(400).json({ error: 'site required' });
  
  const campaign = campaign_name || 'loop-bet-1';
  const key = `${site}:${days || 30}:${campaign}`;
  const timestamp = Date.now();
  approvals[key] = { site, days: days || 30, campaign, approvedAt: timestamp };
  
  res.json({
    status: 'approved',
    campaign_id: key,
    utm_source: site,
    utm_campaign: campaign,
    instructions: `Record your script. When you publish, add these params to the link: ?utm_source=${site}&utm_campaign=${campaign}. Then check /api/measure after 7 days.`,
    approvedAt: timestamp
  });
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

app.listen(PORT, () => console.log(`Loop v1 running → http://localhost:${PORT}`));
