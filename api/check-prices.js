// check-prices: records a new price for tracked gifts and raises sale alerts.
//
// Called two ways:
//   - by cron-job.org every 6 hours: POST with header x-cron-secret: <CRON_SECRET>, checks everyone's gifts
//   - by a signed-in user from the app, body {"event_id"?: uuid, "gift_id"?: uuid}: only that user's gifts,
//     limited to RATE_LIMIT checks per RATE_WINDOW
import { timingSafeEqual } from 'node:crypto';
import { body, database, fail, newId, requireUser, rows, sameOrigin, UUID } from './_lib.js';
import { detectAlert } from '../shared/pricing.js';
import { getProvider } from './_providers.js';

const MAX_GIFTS_PER_RUN = 500;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function cronSecretMatches(candidate) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Records one request and returns true if the user is still under the limit. */
async function consumePriceCheck(db, userId) {
  const now = Date.now();
  const [, inserted] = await db.batch([
    { sql: 'DELETE FROM price_check_requests WHERE user_id = ? AND created_at < ?', args: [userId, now - RATE_WINDOW_MS] },
    // Inserts only while the user is under the limit; the transaction keeps the count exact.
    {
      sql: `INSERT INTO price_check_requests (user_id, created_at)
            SELECT ?, ? WHERE (SELECT COUNT(*) FROM price_check_requests WHERE user_id = ?) < ?`,
      args: [userId, now, userId, RATE_LIMIT],
    },
  ], 'write');
  return inserted.rowsAffected > 0;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const cronHeader = req.headers['x-cron-secret'];
  const isCron = !!cronHeader;
  if (isCron && !cronSecretMatches(String(cronHeader))) return res.status(401).json({ error: 'unauthorized' });

  let userId = null;
  if (!isCron) {
    if (!sameOrigin(req, res)) return;
    userId = await requireUser(req, res);
    if (!userId) return;
  }

  try {
    const db = await database();
    if (userId && !(await consumePriceCheck(db, userId))) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many price checks. Please try again in a few minutes.' });
    }

    const scope = body(req);
    const where = ["track_price = 1", "status = 'wanted'"];
    const args = [];
    if (userId) { where.push('user_id = ?'); args.push(userId); }
    if (typeof scope.event_id === 'string' && UUID.test(scope.event_id)) { where.push('event_id = ?'); args.push(scope.event_id); }
    if (typeof scope.gift_id === 'string' && UUID.test(scope.gift_id)) { where.push('id = ?'); args.push(scope.gift_id); }

    const gifts = rows(await db.execute({
      sql: `SELECT id, user_id, event_id, name, url, current_price, target_price FROM gifts WHERE ${where.join(' AND ')}
            ORDER BY last_checked_at IS NOT NULL, last_checked_at LIMIT ${MAX_GIFTS_PER_RUN}`,
      args,
    }));
    if (!gifts.length) return res.status(200).json({ checked: 0, alerts: 0 });

    const history = rows(await db.execute({
      sql: `SELECT gift_id, price, checked_at FROM price_history WHERE gift_id IN (${gifts.map(() => '?').join(', ')})
            ORDER BY checked_at`,
      args: gifts.map((g) => g.id),
    }));
    const historyByGift = new Map();
    for (const h of history) historyByGift.set(h.gift_id, [...(historyByGift.get(h.gift_id) ?? []), h]);

    const provider = getProvider();
    const now = new Date();
    const at = now.toISOString();
    let checked = 0;
    let alerts = 0;

    for (const gift of gifts) {
      const past = historyByGift.get(gift.id) ?? [];
      let result;
      try {
        result = await provider.getPrice({
          id: gift.id, name: gift.name, url: gift.url, current_price: gift.current_price,
          base_price: past[0]?.price ?? gift.current_price,
        });
      } catch (e) {
        console.error(`price lookup failed for ${gift.id}:`, e);
        continue;
      }
      if (!result) continue;

      const alert = detectAlert(gift, past, result.price, now.getTime());
      const statements = [
        { sql: 'INSERT INTO price_history (user_id, gift_id, price, source, checked_at) VALUES (?, ?, ?, ?, ?)',
          args: [gift.user_id, gift.id, result.price, result.source, at] },
        { sql: 'UPDATE gifts SET current_price = ?, last_checked_at = ? WHERE id = ?', args: [result.price, at, gift.id] },
      ];
      if (alert) {
        statements.push({
          sql: 'INSERT INTO notifications (id, user_id, gift_id, event_id, kind, message) VALUES (?, ?, ?, ?, ?, ?)',
          args: [newId(), gift.user_id, gift.id, gift.event_id, alert.kind, String(alert.message).slice(0, 500)],
        });
        alerts++;
      }
      await db.batch(statements, 'write');
      checked++;
    }

    return res.status(200).json({ checked, alerts, provider: provider.name });
  } catch (error) {
    return fail(res, error);
  }
}
