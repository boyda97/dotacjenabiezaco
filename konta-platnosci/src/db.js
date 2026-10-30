// SQLite wbudowany w Node 22 (node:sqlite) – bez natywnych zależności.
// Przy większym ruchu schemat przenosi się 1:1 do PostgreSQL.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  next TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,               -- Stripe subscription id
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passes (
  id TEXT PRIMARY KEY,               -- Stripe checkout session id
  user_id INTEGER NOT NULL REFERENCES users(id),
  payment_intent TEXT,
  plan TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  amount INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  product TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id),
  program_id TEXT NOT NULL,
  program TEXT NOT NULL,             -- JSON: kopia karty programu z chwili zapisania
  status TEXT NOT NULL DEFAULT 'nowy',
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, program_id)
);
CREATE TABLE IF NOT EXISTS search_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  query TEXT NOT NULL,               -- query string dla /api/programs
  label TEXT,
  updated_at INTEGER NOT NULL
);
-- Alerty e-mail dla abonentów: nowe pasujące nabory i przypomnienia o terminach ulubionych.
CREATE TABLE IF NOT EXISTS alert_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_seen (
  user_id INTEGER NOT NULL REFERENCES users(id),
  program_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, program_id)
);
CREATE TABLE IF NOT EXISTS alert_reminders (
  user_id INTEGER NOT NULL REFERENCES users(id),
  program_id TEXT NOT NULL,
  deadline TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, program_id, deadline)
);
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  fresh INTEGER NOT NULL,
  reminders INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Statystyka odwiedzin bez ciasteczek: tylko liczniki dzienne, bez adresów IP.
CREATE TABLE IF NOT EXISTS stat_views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  ref TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, path, ref)
);
CREATE TABLE IF NOT EXISTS stat_daily (
  day TEXT NOT NULL,
  name TEXT NOT NULL,               -- odslony | unikalni | szukanie | logowanie | zakup_start
  n INTEGER NOT NULL,
  PRIMARY KEY (day, name)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_passes_user ON passes(user_id);
`;

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}
