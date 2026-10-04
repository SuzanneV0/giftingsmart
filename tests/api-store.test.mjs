// Tests for the data API (api/store.js) against a throwaway SQLite file, run with: npm test
// They check the job row-level security used to do: every user only ever sees and changes their own rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'giftingsmart-'));
process.env.TURSO_DATABASE_URL = `file:${join(dir, 'test.db')}`;

const { database } = await import('../api/_lib.js');
const { ops } = await import('../api/store.js');

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
  assert.deepEqual(theirs, { events: [], notifications: [] });
});
