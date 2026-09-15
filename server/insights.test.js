/**
 * Tests for the analytics brain: computeInsights() and betsWithResults().
 *
 * Each test builds a brand-new database that exists only in memory (':memory:'),
 * seeds it with a handful of visits whose outcome we already know, and checks the
 * numbers. No server starts, no file is written, and your real loop.db is never
 * touched. A fresh database per test means no test can leak data into another.
 *
 * This file was impossible before the refactor: computeInsights() lived inside
 * server.js, and importing server.js started a web server and opened loop.db.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import schema from './schema.js';
import insights from './insights.js';

const { openDatabase } = schema;
const { computeInsights, betsWithResults } = insights;

const DAY = 86400000;
// A fixed "now", so "the last 30 days" means exactly the same thing on every run.
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

let db;
beforeEach(() => {
  db = openDatabase(':memory:');
});

// Record one event. Only the columns the analytics read are filled in.
function addEvent({ site = 'acme', vid, type = 'pageview', source = null, campaign = null,
                    landing = '/', ltCampaign = null, ts = NOW - DAY }) {
  db.prepare(`
    INSERT INTO events (site, vid, type, ft_source, ft_campaign, ft_landing, lt_campaign, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(site, vid, type, source, campaign, landing, ltCampaign, ts);
}

// Record a whole visit: one pageview, plus a signup if the visitor converted.
function addVisit({ converts = false, ...fields }) {
  addEvent({ ...fields, type: 'pageview' });
  if (converts) addEvent({ ...fields, type: 'signup' });
}

// Add `count` visitors from one source, the first `signups` of whom convert.
function addTraffic(source, count, signups, extra = {}) {
  for (let i = 0; i < count; i++) {
    addVisit({ vid: `${source}-${i}`, source, converts: i < signups, ...extra });
  }
}

describe('computeInsights() — counting', () => {
  it('returns zeros, not errors, for a site with no data', () => {
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.totals).toEqual({ visitors: 0, signups: 0, rate: 0 });
    expect(r.sources).toEqual([]);
  });

  it('counts each visitor once per source, however many pages they viewed', () => {
    addEvent({ vid: 'v1', source: 'reddit.com' });
    addEvent({ vid: 'v1', source: 'reddit.com' });
    addEvent({ vid: 'v1', source: 'reddit.com' });
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.sources[0]).toMatchObject({ source: 'reddit.com', visitors: 1 });
  });

  it('counts a conversion once per visitor, even if the event fired twice', () => {
    addEvent({ vid: 'v1', source: 'reddit.com', type: 'signup' });
    addEvent({ vid: 'v1', source: 'reddit.com', type: 'signup' });
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.sources[0].signups).toBe(1);
  });

  it('calculates each source rate and the site-wide rate', () => {
    addTraffic('reddit.com', 10, 2);   // 20%
    addTraffic('google', 30, 1);       // ~3.3%
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.totals.visitors).toBe(40);
    expect(r.totals.signups).toBe(3);
    expect(r.totals.rate).toBeCloseTo(3 / 40);
    expect(r.sources.find(s => s.source === 'reddit.com').rate).toBeCloseTo(0.2);
  });

  it('groups visitors with no first-touch source under "direct"', () => {
    addVisit({ vid: 'v1', source: null });
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.sources[0].source).toBe('direct');
  });

  it('lists the best-converting source first', () => {
    addTraffic('google', 50, 1);
    addTraffic('reddit.com', 10, 4);
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.sources[0].source).toBe('reddit.com');
  });
});

describe('computeInsights() — what gets included', () => {
  it('ignores events older than the window', () => {
    addVisit({ vid: 'recent', source: 'reddit.com', ts: NOW - 5 * DAY });
    addVisit({ vid: 'old', source: 'reddit.com', ts: NOW - 45 * DAY });
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.totals.visitors).toBe(1);
  });

  it('never mixes one site’s data into another’s', () => {
    addTraffic('reddit.com', 5, 5, { site: 'acme' });
    addTraffic('reddit.com', 9, 0, { site: 'someone-else' });
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.totals).toMatchObject({ visitors: 5, signups: 5 });
  });

  it('counts whichever conversion event the founder picks', () => {
    addEvent({ vid: 'v1', source: 'reddit.com', type: 'signup' });
    addEvent({ vid: 'v2', source: 'reddit.com', type: 'trial' });
    addEvent({ vid: 'v3', source: 'reddit.com', type: 'trial' });
    expect(computeInsights(db, 'acme', 30, 'signup', NOW).totals.signups).toBe(1);
    expect(computeInsights(db, 'acme', 30, 'trial', NOW).totals.signups).toBe(2);
  });

  it('treats a malicious event name as plain text, not as SQL', () => {
    // If the event name were pasted into the SQL, this would match every row.
    addTraffic('reddit.com', 4, 0);
    const r = computeInsights(db, 'acme', 30, "signup' OR '1'='1", NOW);
    expect(r.totals.signups).toBe(0);
  });
});

describe('computeInsights() — the anomaly flag', () => {
  it('flags a source converting at 2x+ the site average with enough evidence', () => {
    addTraffic('google', 100, 2);      // 2%
    addTraffic('reddit.com', 20, 4);   // 20%, 20 visitors
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.sources.find(s => s.source === 'reddit.com').anomaly).toBe(true);
    expect(r.sources.find(s => s.source === 'google').anomaly).toBe(false);
  });

  it('does NOT flag a lucky single conversion — 1 visitor, 1 signup is not evidence', () => {
    addTraffic('google', 100, 2);
    addTraffic('tiny-blog', 1, 1);     // 100% rate, but one person
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.sources.find(s => s.source === 'tiny-blog').anomaly).toBe(false);
  });

  it('reports vsSite as null rather than dividing by zero when nothing converted', () => {
    addTraffic('google', 10, 0);
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.sources[0].vsSite).toBeNull();
  });
});

describe('computeInsights() — campaign drill-down', () => {
  it('only lists source/campaign/landing combinations that produced a conversion', () => {
    addTraffic('reddit.com', 5, 2, { campaign: 'r-saas', landing: '/blog' });
    addTraffic('google', 5, 0, { campaign: 'ads', landing: '/' });
    const r = computeInsights(db, 'acme', 30, 'signup', NOW);
    expect(r.campaigns).toEqual([
      { source: 'reddit.com', campaign: 'r-saas', landing: '/blog', visitors: 5, signups: 2 }
    ]);
  });
});

describe('betsWithResults() — grading past bets', () => {
  const APPROVED = NOW - 20 * DAY;

  function addBet(campaign, approvedAt = APPROVED, site = 'acme') {
    db.prepare(`INSERT INTO bets (site, campaign, approved_at) VALUES (?, ?, ?)`)
      .run(site, campaign, approvedAt);
  }
  function signup(vid, ltCampaign, ts, site = 'acme') {
    addEvent({ site, vid, type: 'signup', ltCampaign, ts });
  }

  it('returns an empty list when there are no bets', () => {
    expect(betsWithResults(db, 'acme')).toEqual([]);
  });

  it('counts signups carrying the bet’s campaign in the 7 days after approval', () => {
    addBet('loop-bet-1');
    signup('v1', 'loop-bet-1', APPROVED + 1 * DAY);
    signup('v2', 'loop-bet-1', APPROVED + 6 * DAY);
    expect(betsWithResults(db, 'acme')[0].measured_signups).toBe(2);
  });

  it('ignores signups before approval, after the window, or from other campaigns', () => {
    addBet('loop-bet-1');
    signup('before', 'loop-bet-1', APPROVED - DAY);
    signup('too-late', 'loop-bet-1', APPROVED + 8 * DAY);
    signup('other', 'some-other-campaign', APPROVED + DAY);
    expect(betsWithResults(db, 'acme')[0].measured_signups).toBe(0);
  });

  it('includes a signup at exactly 7 days, and excludes one a millisecond later', () => {
    addBet('loop-bet-1');
    signup('on-the-line', 'loop-bet-1', APPROVED + 7 * DAY);
    signup('just-over', 'loop-bet-1', APPROVED + 7 * DAY + 1);
    expect(betsWithResults(db, 'acme')[0].measured_signups).toBe(1);
  });

  it('counts a visitor once even if they signed up twice', () => {
    addBet('loop-bet-1');
    signup('v1', 'loop-bet-1', APPROVED + DAY);
    signup('v1', 'loop-bet-1', APPROVED + 2 * DAY);
    expect(betsWithResults(db, 'acme')[0].measured_signups).toBe(1);
  });

  it('does not count pageviews as results', () => {
    addBet('loop-bet-1');
    addEvent({ vid: 'v1', type: 'pageview', ltCampaign: 'loop-bet-1', ts: APPROVED + DAY });
    expect(betsWithResults(db, 'acme')[0].measured_signups).toBe(0);
  });

  it('keeps each site’s bets separate', () => {
    addBet('loop-bet-1', APPROVED, 'acme');
    addBet('loop-bet-1', APPROVED, 'someone-else');
    signup('v1', 'loop-bet-1', APPROVED + DAY, 'someone-else');
    const acme = betsWithResults(db, 'acme');
    expect(acme).toHaveLength(1);
    expect(acme[0].measured_signups).toBe(0);
  });

  it('returns bets oldest first', () => {
    addBet('newer', APPROVED + DAY);
    addBet('older', APPROVED);
    expect(betsWithResults(db, 'acme').map(b => b.campaign)).toEqual(['older', 'newer']);
  });
});
