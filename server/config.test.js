/**
 * Tests for the configuration layer.
 *
 * config.load(env) is a PURE function — it takes an environment object as an
 * argument instead of reading process.env. That single design choice is what
 * makes this file possible: every case below runs in the same process, in any
 * order, with zero global state to set up or tear down.
 *
 * Had config read process.env directly, each test would have to mutate a global,
 * remember to restore it, and never run in parallel. Testability is not something
 * you bolt on afterwards — it is a property of how the code is shaped.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import configModule from './config.js';

const { load, describe: summarize } = configModule;

// A valid production environment. Individual tests spread this and override one
// field, so each test states exactly one thing and nothing else.
const TMP = os.tmpdir();
const prodEnv = {
  NODE_ENV: 'production',
  LOOP_PASSWORD: 'K7fQ2wR9pL4xN8vB6mT3zY5s', // 24 chars
  LOOP_DB: path.join(TMP, 'loop-test.db')
};

describe('load() — defaults', () => {
  it('boots with a completely empty environment', () => {
    const c = load({});
    expect(c.nodeEnv).toBe('development');
    expect(c.port).toBe(4070);
    expect(c.isProduction).toBe(false);
  });

  it('defaults the database to server/loop.db', () => {
    expect(load({}).dbPath).toBe(path.join(import.meta.dirname, 'loop.db'));
  });

  it('reports auth and AI as disabled when no secrets are set', () => {
    const c = load({});
    expect(c.authEnabled).toBe(false);
    expect(c.aiEnabled).toBe(false);
  });

  it('warns — but still boots — when running unprotected in development', () => {
    const c = load({});
    expect(c.warnings.join(' ')).toMatch(/UNPROTECTED/);
  });
});

describe('load() — PORT', () => {
  it('accepts a valid port', () => {
    expect(load({ PORT: '8080' }).port).toBe(8080);
  });

  it('falls back to the default when PORT is unset or blank', () => {
    expect(load({ PORT: '' }).port).toBe(4070);
    expect(load({}).port).toBe(4070);
  });

  it.each([
    ['80800', 'above the maximum'],
    ['0', 'below the minimum'],
    ['-1', 'negative'],
    ['abc', 'not a number'],
    ['80.5', 'not an integer']
  ])('refuses %s (%s)', (value) => {
    expect(() => load({ PORT: value })).toThrow(/PORT must be an integer/);
  });

  it('accepts the boundary values 1 and 65535', () => {
    expect(load({ PORT: '1' }).port).toBe(1);
    expect(load({ PORT: '65535' }).port).toBe(65535);
  });
});

describe('load() — NODE_ENV', () => {
  it.each(['development', 'production', 'test'])('accepts %s', (env) => {
    // production additionally needs a password, so supply the valid prod env there
    const c = load(env === 'production' ? prodEnv : { NODE_ENV: env });
    expect(c.nodeEnv).toBe(env);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(load({ NODE_ENV: '  Development ' }).nodeEnv).toBe('development');
  });

  it('refuses a typo rather than silently falling back to development', () => {
    // This is the important one: "prodution" quietly meaning "development" is how
    // a server ends up running unprotected while everyone believes it is hardened.
    expect(() => load({ NODE_ENV: 'prodution' })).toThrow(/NODE_ENV must be/);
  });
});

describe('load() — LOOP_PASSWORD', () => {
  it('is optional in development', () => {
    expect(() => load({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('is REQUIRED in production', () => {
    const { LOOP_PASSWORD, ...noPassword } = prodEnv;
    expect(() => load(noPassword)).toThrow(/LOOP_PASSWORD is required/);
  });

  it('must be at least 16 characters in production', () => {
    expect(() => load({ ...prodEnv, LOOP_PASSWORD: 'hunter2' }))
      .toThrow(/at least 16 characters/);
  });

  it('accepts exactly 16 characters (boundary)', () => {
    const c = load({ ...prodEnv, LOOP_PASSWORD: 'a'.repeat(16) });
    expect(c.authEnabled).toBe(true);
  });

  it('rejects 15 characters (boundary)', () => {
    expect(() => load({ ...prodEnv, LOOP_PASSWORD: 'a'.repeat(15) })).toThrow();
  });
});

describe('load() — LOOP_DB', () => {
  it('uses an explicit absolute path', () => {
    const target = path.join(TMP, 'custom.db');
    expect(load({ LOOP_DB: target }).dbPath).toBe(path.resolve(target));
  });

  it('resolves a relative path to an absolute one', () => {
    // Downstream code should never have to wonder whether a path is relative.
    expect(path.isAbsolute(load({ LOOP_DB: './loop.db' }).dbPath)).toBe(true);
  });

  it('refuses to start when the parent directory does not exist', () => {
    // This is the unmounted-volume check: fail before data is written to a disk
    // that is about to disappear, not after.
    const missing = path.join(TMP, 'definitely-not-a-real-dir-9f3a2b', 'loop.db');
    expect(() => load({ LOOP_DB: missing })).toThrow(/does not exist/);
  });

  it('falls back to the default when LOOP_DB is blank', () => {
    expect(load({ LOOP_DB: '   ' }).dbPath).toBe(path.join(import.meta.dirname, 'loop.db'));
  });
});

describe('load() — ANTHROPIC_API_KEY', () => {
  it('is optional — the app runs without AI', () => {
    expect(load({}).aiEnabled).toBe(false);
  });

  it('enables AI when present', () => {
    expect(load({ ANTHROPIC_API_KEY: 'sk-ant-abc123' }).aiEnabled).toBe(true);
  });

  it('warns but does not fail on an unexpected prefix', () => {
    // We cannot truly validate a key without spending money calling the API,
    // so a shape mismatch is a warning, never a hard failure.
    const c = load({ ANTHROPIC_API_KEY: 'wrong-looking-key' });
    expect(c.aiEnabled).toBe(true);
    expect(c.warnings.join(' ')).toMatch(/sk-ant-/);
  });
});

describe('load() — error reporting', () => {
  it('reports EVERY problem at once, not just the first', () => {
    // Fixing config one restart per mistake is miserable. Show the whole list.
    let err;
    try {
      load({ NODE_ENV: 'production', PORT: 'not-a-port' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.errors).toHaveLength(2);
    expect(err.message).toMatch(/PORT/);
    expect(err.message).toMatch(/LOOP_PASSWORD/);
  });

  it('tags the error so callers can distinguish config failures', () => {
    try {
      load({ PORT: 'nope' });
    } catch (e) {
      expect(e.name).toBe('ConfigError');
    }
  });

  it('points the reader at .env.example', () => {
    expect(() => load({ PORT: 'nope' })).toThrow(/\.env\.example/);
  });
});

describe('load() — immutability', () => {
  it('returns a frozen object so nothing can mutate shared config', () => {
    const c = load({});
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.warnings)).toBe(true);
  });
});

describe('describe() — secrets must never reach the logs', () => {
  // The single most important test in this file. Boot logs get pasted into
  // GitHub issues, shipped to third-party log services and shared in chats.
  // A secret printed once is a secret leaked permanently.
  const secretPassword = 'SuperSecretPassword123456';
  const secretKey = 'sk-ant-verysecretvalue999';
  const summary = summarize(load({
    ...prodEnv,
    LOOP_PASSWORD: secretPassword,
    ANTHROPIC_API_KEY: secretKey
  })).join('\n');

  it('never prints the password', () => {
    expect(summary).not.toContain(secretPassword);
  });

  it('never prints the API key', () => {
    expect(summary).not.toContain(secretKey);
  });

  it('still reports whether each secret is set', () => {
    expect(summary).toMatch(/auth\s+ON/);
    expect(summary).toMatch(/ai\s+ON/);
  });

  it('reports secrets as absent when they are not set', () => {
    const s = summarize(load({})).join('\n');
    expect(s).toMatch(/auth\s+OFF/);
    expect(s).toMatch(/ai\s+OFF/);
  });
});
