// delete-account: permanently deletes the signed-in user's account: all their rows in the database,
// then their Clerk user (which signs them out everywhere).
import { body, clerk, database, fail, requireUser, sameOrigin } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!sameOrigin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (body(req).confirm !== true) return res.status(400).json({ error: 'confirmation required' });

  // Only ever deletes the account the caller is signed in as.
  const userId = await requireUser(req, res);
  if (!userId) return;

  try {
    const db = await database();
    // Events cascade to people, gifts, price history and alerts; the rest is removed explicitly.
    await db.batch([
      { sql: 'DELETE FROM notifications WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM price_history WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM gifts WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM recipients WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM events WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM price_check_requests WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM user_settings WHERE user_id = ?', args: [userId] },
    ], 'write');
    await clerk().users.deleteUser(userId);
    return res.status(200).json({ deleted: true });
  } catch (error) {
    return fail(res, error);
  }
}
