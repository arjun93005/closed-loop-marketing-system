/**
 * Loop — database schema
 *
 * The table definitions, and one function that opens a database with them applied.
 *
 * Lives in its own file so the SAME schema can be used by the real server
 * (a file on disk) and by tests (a throwaway in-memory database). If the two ever
 * drifted apart, tests would pass against tables production doesn't have.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');

// Every statement is IF NOT EXISTS, so running this against an existing database
// is harmless: it creates what's missing and leaves existing tables and data alone.
const SCHEMA = `
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
`;

/**
 * Open a database and make sure every table exists.
 *
 * @param {string} filePath  a path on disk, or ':memory:' for a database that
 *                           lives only in RAM and vanishes when closed — what tests use
 * @returns {DatabaseSync}
 */
function openDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDatabase, SCHEMA };
