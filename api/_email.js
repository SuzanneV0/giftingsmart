// Email alerts, sent through Resend (https://resend.com) after a price check finds sales.
//
// Settings (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY  the API key; without it, email alerts are off and the setting is hidden in the app
//   EMAIL_FROM      sender, default "GiftingSmart <alerts@giftingsmart.shop>" (the domain must be verified in Resend)
//   SITE_URL        used for links in the email, default https://giftingsmart.shop
//
// Only people who turned on "Email me about sales" in My account get emails. Their address is
// looked up from Clerk when an email is sent and is never stored in GiftingSmart's database.

export const emailEnabled = () => !!process.env.RESEND_API_KEY;

const siteUrl = () => (process.env.SITE_URL || 'https://giftingsmart.shop').replace(/\/$/, '');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Subject, plain text and HTML for one person's alerts from a price check. */
export function alertEmail(alerts) {
  const site = siteUrl();
  const subject = alerts.length === 1
    ? (alerts[0].kind === 'target' ? 'A gift hit your target price' : 'A gift on your list is on sale')
    : `${alerts.length} gifts on your list dropped in price`;
  const link = (a) => `${site}/#/events/${a.event_id}`;
  const text = [
    ...alerts.map((a) => `- ${a.message}\n  ${link(a)}`),
    '',
    'Prices can change at any time, so check the store before you buy.',
    `To stop these emails, turn off email alerts in My account: ${site}/#/account`,
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#16132a">
  <p>Good news from GiftingSmart:</p>
  <ul>${alerts.map((a) => `<li>${esc(a.message)} <a href="${esc(link(a))}">View the event</a></li>`).join('')}</ul>
  <p style="color:#5b5870;font-size:13px">Prices can change at any time, so check the store before you buy.<br>
  To stop these emails, turn off email alerts in <a href="${esc(site)}/#/account">My account</a>.</p>
</div>`;
  return { subject, text, html };
}

/** Sends one email through Resend's API. Throws if Resend refuses it. */
export async function sendEmail({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'GiftingSmart <alerts@giftingsmart.shop>',
      to: [to],
      subject,
      text,
      html,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
