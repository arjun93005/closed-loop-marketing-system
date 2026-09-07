/**
 * Loop — configuration
 *
 * ONE place that reads the environment. Everything else in the app imports this
 * module and reads plain properties; no other file should ever touch process.env.
 *
 * Why centralize:
 *  1. Discoverable  — every knob the app has is listed in one file you can read.
 *  2. Validated     — bad values are caught HERE, at boot, not at 3am in a handler.
 *  3. Fail fast     — a misconfigured server refuses to start with a clear message,
 *                     instead of starting "fine" and misbehaving later.
 *  4. Testable      — load() is a pure function of an env object, so tests can pass
 *                     fake environments in without mutating the real process.env.
 *
 * This is the "config" leg of the twelve-factor app method: config lives in the
 * environment, never in code, because the SAME build artifact must be able to run
 * on your laptop and in production with nothing different but its environment.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const DEFAULT_PORT = 4070;
const MIN_PRODUCTION_PASSWORD_LENGTH = 16;

/**
 * Load server/.env into process.env, if that file exists.
 *
 * Node 22 has this built in (process.loadEnvFile), so we need no `dotenv` package.
 * Values already present in the real environment are NOT overwritten — the host's
 * env always wins over a local file. That ordering matters: on Railway/Render the
 * platform injects real secrets, and a stale committed .env must never shadow them.
 */
function loadEnvFile(dir = __dirname) {
  const envPath = path.join(dir, '.env');
  try {
    process.loadEnvFile(envPath);
    return envPath;
  } catch {
    return null; // no .env file — completely fine, the host supplies the env
  }
}

/**
 * Build the config object from an environment map.
 *
 * Pure and injectable: pass any object in and get config out. Nothing here reads
 * global state, which is exactly what makes it straightforward to unit test.
 *
 * @param {object} env  usually process.env
 * @returns {object} frozen config
 * @throws {Error} listing EVERY problem found, not just the first one
 */
function load(env = process.env) {
  const errors = [];
  const warnings = [];

  // ---- NODE_ENV -----------------------------------------------------------
  // Drives how strict we are below. Anything that isn't a known value is a typo
  // worth catching: "prodution" silently falling back to dev rules is exactly the
  // kind of bug that only shows up once you're already exposed.
  const nodeEnv = (env.NODE_ENV || 'development').trim().toLowerCase();
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    errors.push(`NODE_ENV must be development, production or test (got "${nodeEnv}").`);
  }
  const isProduction = nodeEnv === 'production';

  // ---- PORT ---------------------------------------------------------------
  // Most hosts inject this. Validate it as a real TCP port rather than letting
  // listen() fail with something cryptic.
  let port = DEFAULT_PORT;
  if (env.PORT !== undefined && String(env.PORT).trim() !== '') {
    const raw = String(env.PORT).trim();
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      errors.push(`PORT must be an integer between 1 and 65535 (got "${raw}").`);
    } else {
      port = parsed;
    }
  }

  // ---- LOOP_DB ------------------------------------------------------------
  // Path to the SQLite file. DEPLOY.md has documented this variable since day one,
  // but the code ignored it and hardcoded server/loop.db — so following our own
  // deploy guide put the database on the container's ephemeral disk and every
  // redeploy silently wiped it. This is that bug's fix.
  //
  // A relative path resolves against the process working directory (what a human
  // typing `LOOP_DB=./data/loop.db` means); an absolute path such as the
  // /data/loop.db mount from DEPLOY.md is used as given.
  const dbPath = env.LOOP_DB && String(env.LOOP_DB).trim()
    ? path.resolve(String(env.LOOP_DB).trim())
    : path.join(__dirname, 'loop.db');

  // The parent directory must exist before SQLite can create the file there.
  // Checking now turns a confusing mid-boot SQLite error into a clear one, and
  // catches the classic "volume was never actually mounted" deploy mistake.
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    errors.push(
      `LOOP_DB points at "${dbPath}" but its directory "${dbDir}" does not exist. ` +
      `Create it, or mount the volume there before starting.`
    );
  }

  // ---- LOOP_PASSWORD ------------------------------------------------------
  // The shared password protecting the dashboard and /api/*. Optional in dev so
  // local work stays frictionless; MANDATORY in production, because the previous
  // behaviour — warn, then start wide open — meant one missing variable silently
  // published every founder's analytics to the internet. A crash is far kinder.
  const password = env.LOOP_PASSWORD ? String(env.LOOP_PASSWORD) : null;
  if (isProduction) {
    if (!password) {
      errors.push(
        'LOOP_PASSWORD is required when NODE_ENV=production. Without it the dashboard ' +
        'and all /api/* routes would be publicly readable and writable.'
      );
    } else if (password.length < MIN_PRODUCTION_PASSWORD_LENGTH) {
      errors.push(
        `LOOP_PASSWORD must be at least ${MIN_PRODUCTION_PASSWORD_LENGTH} characters in ` +
        `production (got ${password.length}). It is the only thing standing between the ` +
        `internet and your data. Generate one with: openssl rand -base64 24`
      );
    }
  } else if (!password) {
    warnings.push('LOOP_PASSWORD not set — dashboard and APIs are UNPROTECTED. Fine locally; never ship this.');
  }

  // ---- ANTHROPIC_API_KEY --------------------------------------------------
  // Optional everywhere: without it /api/generate-scripts returns a clean 503 and
  // the template endpoint still works. We shape-check the prefix only, because the
  // sole way to truly validate a key is to spend money calling the API.
  const anthropicApiKey = env.ANTHROPIC_API_KEY ? String(env.ANTHROPIC_API_KEY).trim() : null;
  if (anthropicApiKey && !anthropicApiKey.startsWith('sk-ant-')) {
    warnings.push('ANTHROPIC_API_KEY does not start with "sk-ant-" — check you pasted the right value.');
  }

  // ---- Report every problem at once ---------------------------------------
  // Deliberately NOT one error at a time: fixing config by trial and error, one
  // restart per mistake, is miserable. Show the whole list.
  if (errors.length) {
    const err = new Error(
      `Invalid configuration — the server cannot start:\n` +
      errors.map(e => `  ✗ ${e}`).join('\n') +
      `\n\nSee .env.example for every supported variable.`
    );
    err.name = 'ConfigError';
    err.errors = errors;
    throw err;
  }

  // Frozen so a stray `config.port = 99` in a handler fails loudly rather than
  // mutating shared state behind everyone's back.
  return Object.freeze({
    nodeEnv,
    isProduction,
    port,
    dbPath,
    password,
    anthropicApiKey,
    authEnabled: password !== null,
    aiEnabled: anthropicApiKey !== null,
    warnings: Object.freeze(warnings)
  });
}

/**
 * Human-readable boot summary.
 *
 * Secrets are reported as present/absent ONLY — never their values. Logs get
 * copied into issues, shipped to third-party log services and pasted into chats;
 * a secret printed once at boot is a secret leaked forever.
 */
function describe(config) {
  return [
    `env      ${config.nodeEnv}`,
    `port     ${config.port}`,
    `database ${config.dbPath}`,
    `auth     ${config.authEnabled ? 'ON (LOOP_PASSWORD set)' : 'OFF — unprotected'}`,
    `ai       ${config.aiEnabled ? 'ON (ANTHROPIC_API_KEY set)' : 'OFF — template scripts only'}`
  ];
}

module.exports = { load, loadEnvFile, describe, DEFAULT_PORT, MIN_PRODUCTION_PASSWORD_LENGTH };
