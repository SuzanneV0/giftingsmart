// check-prices: records a new price for tracked gifts and raises sale alerts.
//
// Called two ways:
//   - by cron-job.org every 6 hours: POST with header x-cron-secret: <CRON_SECRET>, checks everyone's gifts
//     and then removes data past its retention period (see pruneOldData)
//   - by a signed-in user from the app, body {"event_id"?: uuid, "gift_id"?: uuid}: only that user's gifts,
//     limited to RATE_LIMIT checks per RATE_WINDOW
// New alerts are also emailed to people who turned email alerts on (see _email.js).
import { timingSafeEqual } from 'node:crypto';
import { body, clerk, database, fail, newId, requireUser, reserveBudget, rows, sameOrigin, UUID } from './_lib.js';
import { detectAlert } from '../shared/pricing.js';
import { getProvider } from './_providers.js';
import { alertEmail, emailEnabled, sendEmail } from './_email.js';

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const LOOKUPS_AT_ONCE = 5;
// Most alert emails one run will send (Resend bills per email).
const MAX_EMAILS_PER_RUN = Number(process.env.EMAIL_MAX_PER_RUN) || 200;
const DAY_MS = 24 * 60 * 60 * 1000;
// Price history is kept for 12 months after a gift is bought, then deleted.
export const HISTORY_RETENTION_DAYS = 365;

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

/**
 * Deletes data GiftingSmart no longer needs: price history older than HISTORY_RETENTION_DAYS for
 * gifts that were bought more than HISTORY_RETENTION_DAYS ago, and expired rate-limit records.
 */
export async function pruneOldData(db, now = Date.now()) {
  const cutoff = new Date(now - HISTORY_RETENTION_DAYS * DAY_MS).toISOString();
  const [history] = await db.batch([
    {
      sql: `DELETE FROM price_history WHERE checked_at < ? AND gift_id IN
              (SELECT id FROM gifts WHERE status = 'bought' AND bought_at IS NOT NULL AND bought_at < ?)`,
      args: [cutoff, cutoff],
    },
    { sql: 'DELETE FROM price_check_requests WHERE created_at < ?', args: [now - RATE_WINDOW_MS] },
  ], 'write');
  return { priceHistoryDeleted: history.rowsAffected };
}

/** Emails each person who opted in the alerts this run created for them. Failures are logged, not thrown. */
async function emailAlerts(db, alertsByUser) {
  if (!emailEnabled() || !alertsByUser.size) return 0;
  const ids = [...alertsByUser.keys()].slice(0, MAX_EMAILS_PER_RUN);
  const optedIn = rows(await db.execute({
    sql: `SELECT user_id FROM user_settings WHERE email_alerts = 1 AND user_id IN (${ids.map(() => '?').join(', ')})`,
    args: ids,
  }));
  let sent = 0;
  for (const { user_id: userId } of optedIn) {
    try {
      const user = await clerk().users.getUser(userId);
      const to = user.primaryEmailAddress?.emailAddress;
      if (!to) continue;
      await sendEmail({ to, ...alertEmail(alertsByUser.get(userId)) });
      sent++;
    } catch (e) {
      console.error(`alert email failed for ${userId}:`, e);
    }
  }
  return sent;
}

/** Runs fn over items with at most `limit` running at once. */
async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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

    const provider = getProvider();
    // Real price lookups cost money, so the app's "Check prices now" skips gifts checked recently.
    if (userId && provider.minRecheckMs) {
      where.push('(last_checked_at IS NULL OR last_checked_at < ?)');
      args.push(new Date(Date.now() - provider.minRecheckMs).toISOString());
    }
    let gifts = rows(await db.execute({
      sql: `SELECT id, user_id, event_id, name, url, current_price, target_price FROM gifts WHERE ${where.join(' AND ')}
            ORDER BY last_checked_at IS NOT NULL, last_checked_at LIMIT ${Number(provider.maxPerRun) || 100}`,
      args,
    }));
    // Paid providers have a daily budget shared by every run and user; once it's spent, nothing is looked up.
    if (gifts.length && provider.dailyLimit) {
      const granted = await reserveBudget(db, provider.name, gifts.length, provider.dailyLimit);
      gifts = gifts.slice(0, granted);
    }
    const retention = isCron ? await pruneOldData(db) : undefined;
    if (!gifts.length) return res.status(200).json({ checked: 0, alerts: 0, retention });

    const history = rows(await db.execute({
      sql: `SELECT gift_id, price, checked_at FROM price_history WHERE gift_id IN (${gifts.map(() => '?').join(', ')})
            ORDER BY checked_at`,
      args: gifts.map((g) => g.id),
    }));
    const historyByGift = new Map();
    for (const h of history) historyByGift.set(h.gift_id, [...(historyByGift.get(h.gift_id) ?? []), h]);

    const now = new Date();
    const at = now.toISOString();
    let checked = 0;
    let alerts = 0;
    const alertsByUser = new Map();

    await eachLimited(gifts, LOOKUPS_AT_ONCE, async (gift) => {
      const past = historyByGift.get(gift.id) ?? [];
      let result;
      try {
        result = await provider.getPrice({
          id: gift.id, name: gift.name, url: gift.url, current_price: gift.current_price,
          base_price: past[0]?.price ?? gift.current_price,
        });
      } catch (e) {
        console.error(`price lookup failed for ${gift.id}:`, e);
        return;
      }
      if (!result) return;

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
      }
      await db.batch(statements, 'write');
      checked++;
      if (alert) {
        alerts++;
        alertsByUser.set(gift.user_id, [...(alertsByUser.get(gift.user_id) ?? []), { ...alert, event_id: gift.event_id }]);
      }
    });

    const emailed = await emailAlerts(db, alertsByUser);
    return res.status(200).json({ checked, alerts, emailed, provider: provider.name, retention });
  } catch (error) {
    return fail(res, error);
  }
}
