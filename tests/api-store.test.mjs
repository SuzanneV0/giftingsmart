// Tests for the data API (api/store.js) against a throwaway SQLite file, run with: npm test
// They check that every user only ever sees and changes their own rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'giftingsmart-'));
process.env.TURSO_DATABASE_URL = `file:${join(dir, 'test.db')}`;

const { database } = await import('../api/_lib.js');
const { ops } = await import('../api/store.js');
const { pruneOldData, HISTORY_RETENTION_DAYS } = await import('../api/check-prices.js');

let db;
const ALICE = 'user_alice';
const BOB = 'user_bob';

before(async () => {
  db = await database();
});
after(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows can keep the file locked briefly; it's in the temp folder either way */
  }
});

test('creates an event with its people and lists it back', async () => {
  const event = await ops.createEvent(db, ALICE, [
    { name: 'Christmas', event_date: '2026-12-25', budget_mode: 'per_recipient', total_budget: null },
    [{ name: 'Mom', budget: 100 }, { name: 'Dad', budget: 50 }],
  ]);
  assert.equal(event.name, 'Christmas');
  const events = await ops.listEvents(db, ALICE, []);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].recipients.map((r) => r.name).sort(), ['Dad', 'Mom']);
});

test("another user can't see, change or delete someone else's event", async () => {
  const [event] = await ops.listEvents(db, ALICE, []);
  assert.deepEqual(await ops.listEvents(db, BOB, []), []);
  assert.equal(await ops.getEvent(db, BOB, [event.id]), null);

  await ops.updateEvent(db, BOB, [event.id, { name: 'Hacked' }]);
  await ops.deleteEvent(db, BOB, [event.id]);
  const still = await ops.getEvent(db, ALICE, [event.id]);
  assert.equal(still.name, 'Christmas');

  await assert.rejects(ops.addGift(db, BOB, [event.id, { name: 'Sneaky gift' }]), /event not found/);
  await assert.rejects(ops.addRecipient(db, BOB, [event.id, { name: 'Sneaky person' }]), /event not found/);
});

test('gifts only accept known fields and a person from the same event', async () => {
  const [event] = await ops.listEvents(db, ALICE, []);
  const mom = event.recipients.find((r) => r.name === 'Mom');

  const gift = await ops.addGift(db, ALICE, [event.id, {
    name: 'Scarf', recipient_id: mom.id, current_price: 89, track_price: true, user_id: BOB, id: 'forged',
  }]);
  assert.equal(gift.user_id, ALICE, 'user_id comes from the session, never the request');
  assert.notEqual(gift.id, 'forged');
  assert.equal(gift.track_price, true, 'booleans come back as booleans');

  const other = await ops.createEvent(db, ALICE, [{ name: 'Birthday', budget_mode: 'total', total_budget: 50 }, []]);
  await assert.rejects(ops.addGift(db, ALICE, [other.id, { name: 'Mug', recipient_id: mom.id }]), /recipient not found/);
  await assert.rejects(ops.updateGift(db, ALICE, [gift.id, { recipient_id: crypto.randomUUID() }]), /recipient not found/);
});

test('marks a gift bought and back', async () => {
  const [event] = await ops.listEvents(db, ALICE, []);
  const gift = event.gifts[0];
  await ops.updateGift(db, ALICE, [gift.id, { status: 'bought', amount_spent: 79.5, bought_at: new Date().toISOString() }]);
  let fresh = (await ops.getEvent(db, ALICE, [event.id])).gifts[0];
  assert.equal(fresh.status, 'bought');
  assert.equal(fresh.amount_spent, 79.5);
  await ops.updateGift(db, ALICE, [gift.id, { status: 'wanted', amount_spent: null, bought_at: null }]);
  fresh = (await ops.getEvent(db, ALICE, [event.id])).gifts[0];
  assert.equal(fresh.status, 'wanted');
});

test('rejects invalid values with a database check', async () => {
  const [event] = await ops.listEvents(db, ALICE, []);
  await assert.rejects(ops.addGift(db, ALICE, [event.id, { name: 'Bad link', url: 'javascript:alert(1)' }]));
  await assert.rejects(ops.addGift(db, ALICE, [event.id, { name: 'Negative', current_price: -5 }]));
});

test('notifications: only your own are listed and marked read', async () => {
  const [event] = await ops.listEvents(db, ALICE, []);
  const gift = event.gifts[0];
  const id = crypto.randomUUID();
  await db.execute({
    sql: 'INSERT INTO notifications (id, user_id, gift_id, event_id, kind, message) VALUES (?, ?, ?, ?, ?, ?)',
    args: [id, ALICE, gift.id, event.id, 'sale', 'Scarf dropped to $70'],
  });
  assert.equal((await ops.listNotifications(db, BOB, [])).length, 0);
  await ops.markNotificationsRead(db, BOB, [[id]]);
  assert.equal((await ops.listNotifications(db, ALICE, []))[0].read, false);
  await ops.markNotificationsRead(db, ALICE, [[id]]);
  assert.equal((await ops.listNotifications(db, ALICE, []))[0].read, true);
});

test('deleting an event removes its people, gifts and alerts', async () => {
  const [event] = await ops.listEvents(db, ALICE, []);
  await ops.deleteEvent(db, ALICE, [event.id]);
  for (const table of ['recipients', 'gifts', 'notifications']) {
    const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE event_id = ?`, args: [event.id] });
    assert.equal(Number(rows[0].n), 0, `${table} left behind`);
  }
});

test('export contains only your data', async () => {
  const mine = await ops.exportData(db, ALICE, []);
  const theirs = await ops.exportData(db, BOB, []);
  assert.ok(mine.events.length >= 1);
  assert.deepEqual(theirs, { events: [], notifications: [], settings: null });
});

test('email alert setting: off by default, saved per user, included in the export', async () => {
  delete process.env.RESEND_API_KEY;
  assert.deepEqual(await ops.getSettings(db, ALICE, []), { email_alerts: false, email_available: false });
  process.env.RESEND_API_KEY = 're_test';
  try {
    await ops.updateSettings(db, ALICE, [{ email_alerts: true }]);
    await ops.updateSettings(db, ALICE, [{ email_alerts: 'yes' }]); // not a boolean: ignored
    assert.deepEqual(await ops.getSettings(db, ALICE, []), { email_alerts: true, email_available: true });
    assert.equal((await ops.getSettings(db, BOB, [])).email_alerts, false, "one user's setting never applies to another");
    assert.equal((await ops.exportData(db, ALICE, [])).settings.email_alerts, true);
    await ops.updateSettings(db, ALICE, [{ email_alerts: false }]);
    assert.equal((await ops.getSettings(db, ALICE, [])).email_alerts, false);
  } finally {
    delete process.env.RESEND_API_KEY;
  }
});

test('retention: deletes old price history only for gifts bought over 12 months ago', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const ago = (days) => new Date(now - days * DAY).toISOString();
  const event = await ops.createEvent(db, ALICE, [{ name: 'Retention', budget_mode: 'total', total_budget: 100 }, []]);
  const oldBought = await ops.addGift(db, ALICE, [event.id, { name: 'Old bought', status: 'bought', bought_at: ago(400) }]);
  const newBought = await ops.addGift(db, ALICE, [event.id, { name: 'Recently bought', status: 'bought', bought_at: ago(30) }]);
  const wanted = await ops.addGift(db, ALICE, [event.id, { name: 'Still wanted' }]);
  const addHistory = (giftId, days) => db.execute({
    sql: 'INSERT INTO price_history (user_id, gift_id, price, checked_at) VALUES (?, ?, ?, ?)',
    args: [ALICE, giftId, 10, ago(days)],
  });
  for (const g of [oldBought, newBought, wanted]) {
    await addHistory(g.id, HISTORY_RETENTION_DAYS + 50);
    await addHistory(g.id, 10);
  }
  await db.execute({ sql: 'INSERT INTO price_check_requests (user_id, created_at) VALUES (?, ?)', args: [ALICE, now - DAY] });

  const { priceHistoryDeleted } = await pruneOldData(db, now);
  assert.equal(priceHistoryDeleted, 1);
  const count = async (giftId) => Number((await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM price_history WHERE gift_id = ?', args: [giftId],
  })).rows[0].n);
  assert.equal(await count(oldBought.id), 1, 'only the history older than 12 months goes');
  assert.equal(await count(newBought.id), 2);
  assert.equal(await count(wanted.id), 2);
  const { rows: left } = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM price_check_requests WHERE user_id = ?', args: [ALICE] });
  assert.equal(Number(left[0].n), 0, 'expired rate-limit records are removed');
});

test('reserveBudget grants calls up to the daily limit and then none', async () => {
  const { database, reserveBudget } = await import('../api/_lib.js');
  const db = await database();
  assert.equal(await reserveBudget(db, 'test-svc', 5, 8), 5);
  assert.equal(await reserveBudget(db, 'test-svc', 5, 8), 3);
  assert.equal(await reserveBudget(db, 'test-svc', 5, 8), 0);
});
