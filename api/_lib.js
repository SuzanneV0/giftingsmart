// Shared server code for GiftingSmart's API (Vercel Functions). Files starting with "_" aren't routes.
//
// Settings (Vercel → Settings → Environment Variables):
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN  the database
//   CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY  sign-in (the publishable key is also written into config.js)
//   CRON_SECRET                            shared with cron-job.org for the scheduled price check
//   PRICE_PROVIDER, SERPAPI_KEY            where prices come from (see _providers.js)
//   RESEND_API_KEY, EMAIL_FROM             email alerts (see _email.js)
//
// The browser never talks to the database. Every function checks the Clerk session and scopes every
// query to the signed-in user's own rows.
import { createClient } from '@libsql/client';
import { createClerkClient, verifyToken } from '@clerk/backend';

let db = null;
let schemaReady = null;

// Created on first use, so a fresh database needs no setup step. user_id is the Clerk user id;
// nothing else about the person (name, email) is stored here.
const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  event_date TEXT,
  budget_mode TEXT NOT NULL DEFAULT 'total' CHECK (budget_mode IN ('total', 'per_recipient')),
  total_budget REAL CHECK (total_budget IS NULL OR total_budget >= 0),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS events_user_idx ON events (user_id);
CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  budget REAL CHECK (budget IS NULL OR budget >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS recipients_event_idx ON recipients (event_id);
CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  recipient_id TEXT REFERENCES recipients (id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  url TEXT CHECK (url IS NULL OR (length(url) <= 2048 AND (url LIKE 'http://%' OR url LIKE 'https://%'))),
  current_price REAL CHECK (current_price IS NULL OR current_price >= 0),
  target_price REAL CHECK (target_price IS NULL OR target_price >= 0),
  track_price INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'wanted' CHECK (status IN ('wanted', 'bought')),
  amount_spent REAL CHECK (amount_spent IS NULL OR amount_spent >= 0),
  bought_at TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS gifts_event_idx ON gifts (event_id);
CREATE INDEX IF NOT EXISTS gifts_tracking_idx ON gifts (track_price, status, last_checked_at);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  gift_id TEXT NOT NULL REFERENCES gifts (id) ON DELETE CASCADE,
  price REAL NOT NULL CHECK (price >= 0),
  source TEXT NOT NULL DEFAULT 'mock' CHECK (length(source) <= 40),
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS price_history_gift_idx ON price_history (gift_id, checked_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gift_id TEXT REFERENCES gifts (id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events (id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale', 'target')),
  message TEXT NOT NULL CHECK (length(message) <= 500),
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, read);
CREATE TABLE IF NOT EXISTS price_check_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS price_check_requests_user_idx ON price_check_requests (user_id, created_at);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  email_alerts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

export async function database() {
  if (!db) {
    if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is not set');
    db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  if (!schemaReady) schemaReady = db.executeMultiple(SCHEMA).catch((e) => { schemaReady = null; throw e; });
  await schemaReady;
  return db;
}

export const clerk = () => createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

/** The signed-in Clerk user id, or sends a 401 and returns null. */
export async function requireUser(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'Please sign in.' }); return null; }
  try {
    const { sub } = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    return sub;
  } catch {
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    return null;
  }
}

/** Requests from browsers on other websites are refused. */
export function sameOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== `https://${req.headers.host}` && !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
    res.status(403).json({ error: 'origin not allowed' });
    return false;
  }
  return true;
}

export function body(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

// SQLite has no booleans: turn 0/1 back into true/false for the app.
const BOOLEANS = new Set(['track_price', 'read', 'email_alerts']);
export function rows(result) {
  return result.rows.map((row) => {
    const out = {};
    result.columns.forEach((col, i) => {
      let v = row[i];
      if (typeof v === 'bigint') v = Number(v);
      if (BOOLEANS.has(col) && v !== null) v = Boolean(v);
      out[col] = v;
    });
    return out;
  });
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function fail(res, error) {
  console.error(error);
  const constraint = /CHECK constraint|FOREIGN KEY|NOT NULL/i.test(String(error?.message));
  res.status(constraint ? 400 : 500).json({ error: constraint ? 'Some of those details aren’t valid.' : 'Something went wrong. Please try again.' });
}
