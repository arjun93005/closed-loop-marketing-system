/**
 * Loop — analytics
 *
 * The "Decide" and "Measure" brain of the product: turning raw events into
 * per-source conversion numbers, and grading past bets.
 *
 * Every function takes the database as its FIRST ARGUMENT instead of reaching for
 * a global. That is the same move that made config.load(env) testable: the server
 * passes in the real database, and tests pass in a fresh in-memory one seeded with
 * traffic they control. Nothing here knows or cares about HTTP.
 */
'use strict';

const DAY_MS = 86400000;
const BET_WINDOW_DAYS = 7;

// ---------- Insights ----------
// Aggregates by FIRST-TOUCH source: which discovery channel produces signups.
// A visitor counts once; they convert if they ever fired the conversion event in the window.
//
// `now` defaults to the real clock. Tests pass a fixed value so "the last 30 days"
// means the same thing every time the test runs.
function computeInsights(db, site, days, conversionEvent = 'signup', now = Date.now()) {
  const since = now - days * DAY_MS;
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

// ---------- Bets ----------
// For a given site, return each past bet joined with its LIVE measured result:
// how many signups carried that bet's campaign in the 7 days after approval.
// Recomputed every call so the "what worked" signal is never stale.
//
// Known inefficiency, kept deliberately in this move: the count query is prepared
// inside the loop (an "N+1" — one extra query per bet). Fixing it belongs to the
// scaling step; a refactor that also changes behaviour is harder to verify.
function betsWithResults(db, site) {
  const bets = db.prepare(`SELECT * FROM bets WHERE site = ? ORDER BY approved_at ASC`).all(site);
  return bets.map(b => {
    const windowEnd = b.approved_at + BET_WINDOW_DAYS * DAY_MS;
    const r = db.prepare(`
      SELECT COUNT(DISTINCT vid) AS signups FROM events
      WHERE site = ? AND type = 'signup' AND lt_campaign = ?
        AND ts >= ? AND ts <= ?
    `).get(site, b.campaign, b.approved_at, windowEnd);
    return { ...b, measured_signups: r.signups || 0 };
  });
}

module.exports = { computeInsights, betsWithResults };
