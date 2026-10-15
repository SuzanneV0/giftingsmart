// GiftingSmart's data API: one POST endpoint whose `op` mirrors the methods of the browser's store
// (js/store.js). Every query is scoped to the signed-in user, and writes only accept known columns.
import { body, database, fail, newId, requireUser, rows, sameOrigin, UUID } from './_lib.js';
import { emailEnabled } from './_email.js';

// Columns the browser may set on each table (never id, user_id, event_id or timestamps it doesn't own).
const EVENT_FIELDS = ['name', 'event_date', 'budget_mode', 'total_budget', 'notes'];
const RECIPIENT_FIELDS = ['name', 'budget'];
const GIFT_FIELDS = ['recipient_id', 'name', 'url', 'current_price', 'target_price', 'track_price', 'status', 'amount_spent', 'bought_at'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (obj && f in obj) out[f] = typeof obj[f] === 'boolean' ? (obj[f] ? 1 : 0) : obj[f] ?? null;
  }
  return out;
}

function isId(v) {
  return typeof v === 'string' && UUID.test(v);
}

async function insert(db, table, values) {
  const cols = Object.keys(values);
  const result = await db.execute({
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`,
    args: cols.map((c) => values[c]),
  });
  return rows(result)[0];
}

async function update(db, table, id, userId, values) {
  const cols = Object.keys(values);
  if (!cols.length) return;
  await db.execute({
    sql: `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
    args: [...cols.map((c) => values[c]), id, userId],
  });
}

async function ownsEvent(db, userId, eventId) {
  if (!isId(eventId)) return false;
  const r = await db.execute({ sql: 'SELECT 1 FROM events WHERE id = ? AND user_id = ?', args: [eventId, userId] });
  return r.rows.length > 0;
}

/** A gift's person must belong to the same event (so the same user). */
async function recipientInEvent(db, recipientId, eventId) {
  if (recipientId == null) return true;
  if (!isId(recipientId)) return false;
  const r = await db.execute({ sql: 'SELECT 1 FROM recipients WHERE id = ? AND event_id = ?', args: [recipientId, eventId] });
  return r.rows.length > 0;
}

/** Events with their people and gifts (and each gift's price history when asked). */
async function eventsWithChildren(db, userId, eventIds, historyCols) {
  if (!eventIds.length) return { recipients: [], gifts: [], history: [] };
  const list = eventIds.map(() => '?').join(', ');
  const [recipients, gifts] = await db.batch([
    { sql: `SELECT * FROM recipients WHERE user_id = ? AND event_id IN (${list})`, args: [userId, ...eventIds] },
    { sql: `SELECT * FROM gifts WHERE user_id = ? AND event_id IN (${list})`, args: [userId, ...eventIds] },
  ], 'read');
  const giftRows = rows(gifts);
  let history = [];
  if (historyCols && giftRows.length) {
    history = rows(await db.execute({
      sql: `SELECT gift_id, ${historyCols} FROM price_history WHERE user_id = ? AND gift_id IN (${giftRows.map(() => '?').join(', ')})
            ORDER BY checked_at`,
      args: [userId, ...giftRows.map((g) => g.id)],
    }));
  }
  return { recipients: rows(recipients), gifts: giftRows, history };
}

function assemble(events, { recipients, gifts, history }, withHistory) {
  return events.map((e) => ({
    ...e,
    recipients: recipients.filter((r) => r.event_id === e.id),
    gifts: gifts
      .filter((g) => g.event_id === e.id)
      .map((g) => (withHistory
        ? { ...g, price_history: history.filter((h) => h.gift_id === g.id).map(({ gift_id, ...h }) => h) }
        : g)),
  }));
}

export const ops = {
  async listEvents(db, userId) {
    const events = rows(await db.execute({
      sql: 'SELECT * FROM events WHERE user_id = ? ORDER BY event_date IS NULL, event_date',
      args: [userId],
    }));
    return assemble(events, await eventsWithChildren(db, userId, events.map((e) => e.id)), false);
  },

  async getEvent(db, userId, [id]) {
    if (!isId(id)) return null;
    const events = rows(await db.execute({ sql: 'SELECT * FROM events WHERE id = ? AND user_id = ?', args: [id, userId] }));
    if (!events.length) return null;
    return assemble(events, await eventsWithChildren(db, userId, [id], 'price, checked_at'), true)[0];
  },

  async createEvent(db, userId, [event, recipients = []]) {
    const id = newId();
    const statements = [
      {
        sql: `INSERT INTO events (id, user_id, ${EVENT_FIELDS.join(', ')}) VALUES (?, ?, ${EVENT_FIELDS.map(() => '?').join(', ')})`,
        args: [id, userId, ...EVENT_FIELDS.map((f) => event?.[f] ?? null)],
      },
      ...(Array.isArray(recipients) ? recipients.slice(0, 100) : []).map((r) => ({
        sql: 'INSERT INTO recipients (id, user_id, event_id, name, budget) VALUES (?, ?, ?, ?, ?)',
        args: [newId(), userId, id, r?.name ?? null, r?.budget ?? null],
      })),
    ];
    await db.batch(statements, 'write');
    return rows(await db.execute({ sql: 'SELECT * FROM events WHERE id = ?', args: [id] }))[0];
  },

  async updateEvent(db, userId, [id, patch]) {
    await update(db, 'events', id, userId, pick(patch, EVENT_FIELDS));
  },

  async deleteEvent(db, userId, [id]) {
    await db.execute({ sql: 'DELETE FROM events WHERE id = ? AND user_id = ?', args: [id, userId] });
  },

  async addRecipient(db, userId, [eventId, recipient]) {
    if (!(await ownsEvent(db, userId, eventId))) throw Object.assign(new Error('event not found'), { status: 404 });
    await insert(db, 'recipients', { id: newId(), user_id: userId, event_id: eventId, ...pick(recipient, RECIPIENT_FIELDS) });
  },

  async updateRecipient(db, userId, [id, patch]) {
    await update(db, 'recipients', id, userId, pick(patch, RECIPIENT_FIELDS));
  },

  async deleteRecipient(db, userId, [id]) {
    await db.execute({ sql: 'DELETE FROM recipients WHERE id = ? AND user_id = ?', args: [id, userId] });
  },

  async addGift(db, userId, [eventId, gift]) {
    if (!(await ownsEvent(db, userId, eventId))) throw Object.assign(new Error('event not found'), { status: 404 });
    const values = pick(gift, GIFT_FIELDS);
    if (!(await recipientInEvent(db, values.recipient_id, eventId))) throw Object.assign(new Error('recipient not found'), { status: 404 });
    return insert(db, 'gifts', { id: newId(), user_id: userId, event_id: eventId, ...values });
  },

  async updateGift(db, userId, [id, patch]) {
    const values = pick(patch, GIFT_FIELDS);
    if ('recipient_id' in values) {
      const g = await db.execute({ sql: 'SELECT event_id FROM gifts WHERE id = ? AND user_id = ?', args: [id, userId] });
      if (!g.rows.length) return;
      if (!(await recipientInEvent(db, values.recipient_id, g.rows[0].event_id))) throw Object.assign(new Error('recipient not found'), { status: 404 });
    }
    await update(db, 'gifts', id, userId, values);
  },

  async deleteGift(db, userId, [id]) {
    await db.execute({ sql: 'DELETE FROM gifts WHERE id = ? AND user_id = ?', args: [id, userId] });
  },

  async listNotifications(db, userId) {
    return rows(await db.execute({
      sql: 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      args: [userId],
    }));
  },

  async markNotificationsRead(db, userId, [ids]) {
    const list = (Array.isArray(ids) ? ids : []).filter(isId).slice(0, 200);
    if (!list.length) return;
    await db.execute({
      sql: `UPDATE notifications SET read = 1 WHERE user_id = ? AND id IN (${list.map(() => '?').join(', ')})`,
      args: [userId, ...list],
    });
  },

  /** Account settings kept on the server (other preferences stay in the browser). */
  async getSettings(db, userId) {
    const [row] = rows(await db.execute({ sql: 'SELECT email_alerts FROM user_settings WHERE user_id = ?', args: [userId] }));
    return { email_alerts: row?.email_alerts ?? false, email_available: emailEnabled() };
  },

  async updateSettings(db, userId, [patch]) {
    if (typeof patch?.email_alerts !== 'boolean') return;
    await db.execute({
      sql: `INSERT INTO user_settings (user_id, email_alerts, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET email_alerts = excluded.email_alerts, updated_at = excluded.updated_at`,
      args: [userId, patch.email_alerts ? 1 : 0, new Date().toISOString()],
    });
  },

  /** Everything stored about the user, for "Download my data" (the browser adds the account details from Clerk). */
  async exportData(db, userId) {
    const events = rows(await db.execute({ sql: 'SELECT * FROM events WHERE user_id = ?', args: [userId] }));
    const children = await eventsWithChildren(db, userId, events.map((e) => e.id), 'price, source, checked_at');
    const notifications = rows(await db.execute({ sql: 'SELECT * FROM notifications WHERE user_id = ?', args: [userId] }));
    const [settings] = rows(await db.execute({ sql: 'SELECT email_alerts, updated_at FROM user_settings WHERE user_id = ?', args: [userId] }));
    return { events: assemble(events, children, true), notifications, settings: settings ?? null };
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!sameOrigin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const userId = await requireUser(req, res);
  if (!userId) return;

  const { op, args = [] } = body(req);
  if (!Object.hasOwn(ops, op) || !Array.isArray(args)) return res.status(400).json({ error: 'unknown operation' });

  try {
    const db = await database();
    const result = await ops[op](db, userId, args);
    return res.status(200).json({ result: result ?? null });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: error.message });
    return fail(res, error);
  }
}
