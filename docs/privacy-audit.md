# Privacy audit: GiftingSmart

**Updated:** October 15, 2026, for the current setup: Clerk sign-in, a Turso database, Vercel Functions, optional SerpApi prices and Resend email alerts.
**Scope:** the live site (giftingsmart.shop), the browser code in `js/`, the server code in `api/`, the build script, and the providers listed below.
**Framework:** Canada's PIPEDA fair information principles, plus general good practice (GDPR-style data minimisation and user rights).

This is a technical audit, not legal advice. The policies still need a review by a lawyer (see [Open items](#open-items)).

## Current setup at a glance

| Part | Provider | Where | Personal information it handles |
|---|---|---|---|
| Sign-in | Clerk (Google only) | United States | Name, email, Google account ID, profile photo link |
| Database | Turso (libSQL) | Canada (Montréal) | Clerk user ID, events, people, gifts, prices, alerts, the email alert setting |
| Server code | Vercel Functions, region `yul1` | Canada (Montréal) | Everything above while handling a request |
| Website delivery | Vercel | Global network | Server logs (IP, browser, address, time) |
| Scheduled price check | cron-job.org | Germany | None: it only sends a secret header |
| Prices (when `PRICE_PROVIDER=serpapi`) | SerpApi (Google Shopping) | United States | Gift names only |
| Email alerts (when `RESEND_API_KEY` is set) | Resend | United States | The email address and alert text of people who opt in |
| Analytics (after consent) | Google Analytics | United States | Anonymised page views |

SerpApi and Resend appear in the privacy policy's provider table only once they're switched on: `scripts/build.mjs` adds their rows when `PRICE_PROVIDER` or `RESEND_API_KEY` is set at build time. The footer, About page, Terms and event pages also stop saying prices are simulated once a real provider is set.

## What personal information exists, and where

| Data | Source | Stored in | Who can read it |
|---|---|---|---|
| Name, email, Google ID, profile photo link | Google sign-in | Clerk | You, and the server functions (to delete the account or send an alert email) |
| Events, people (names, budgets), gifts, prices paid, links | You | Turso | You only: every query is scoped to your Clerk user ID |
| Price history and price alerts | `api/check-prices.js` | Turso | You only (read); the server writes them |
| Email alert setting (on or off) | You, in My account | Turso (`user_settings`) | You only |
| Rate-limit records (one row per price check you start) | `api/check-prices.js` | Turso | Server only; removed after 10 minutes |
| Sign-in session | Clerk | Your browser (cookies) | Your browser |
| Preferences (theme, currency, browser notifications) | You | Your browser (localStorage) | Your browser |
| Server logs (IP, user agent, address, time) | Automatic | Vercel, Turso, Clerk | Providers, for operations and security |

GiftingSmart's database never stores a name or email address. When an alert email is sent, the address is looked up from Clerk at that moment and passed straight to Resend.

## Checks performed

### Data API (`api/store.js`)
- **Per-user isolation:** every operation takes the user ID from the verified Clerk session token, never from the request, and every query filters on it. `tests/api-store.test.mjs` checks that one user can't list, read, change or delete another's events, people, gifts, alerts or settings.
- **Allowed columns only:** each table has a list of fields the browser may set; `id`, `user_id` and timestamps are always set by the server.
- **Integrity:** a gift's person must belong to the same event. Database checks limit text lengths, require gift links to start with `http://` or `https://`, and reject negative amounts.
- **Errors:** clients get a generic message; details go to the function logs.

### Price checker (`api/check-prices.js`)
- **Two ways in:** a signed-in user's token (then only that user's gifts are touched) or the cron secret, compared in constant time. A wrong secret gets 401.
- **Rate limit:** 20 user-started checks per account per 10 minutes, counted and recorded in one transaction.
- **Cost control with a real provider:** each run checks at most `SERPAPI_MAX_PER_RUN` gifts (default 100, least recently checked first), identical searches in a run are made once, and "Check prices now" skips gifts checked in the last hour.
- **What SerpApi receives:** the gift's name and the API key, nothing else. The store link is used only on the server, to choose that store's offer from the results. `tests/providers.test.mjs` checks the request contents.

### Email alerts (`api/_email.js`)
- **Opt-in:** off by default. "Email me when a gift goes on sale or hits my target price" in My account turns it on, and the setting is hidden when the site has no Resend key.
- **One email per person per check**, listing that run's alerts, with a link to turn email alerts off.
- **Escaping:** gift names are HTML-escaped in the email body (tested).
- Sending failures are logged and never stop the price check.

### Retention
- After each scheduled check, `pruneOldData` deletes price history older than 12 months for gifts that were marked bought more than 12 months ago, and expired rate-limit records. Price history for gifts still on a list is kept, since sale detection uses it. The privacy policy's "How long we keep it" section says this.
- Deleting an event cascades to its people, gifts, price history and alerts. Deleting the account removes every row with the user's ID (including `user_settings` and rate-limit records), then the Clerk user.

### Browser
- **Third parties:** fonts are self-hosted. Clerk's script loads only for someone signing in or already signed in. The Google profile photo is never requested (initials instead). Before consent, other visitors' browsers contact only giftingsmart.shop.
- **Content Security Policy** (`vercel.json`): scripts and network calls only to the site and Clerk, plus Google Analytics after consent; no plugins; no framing.
- **XSS:** user text is HTML-escaped wherever it's shown; gift links must be `http(s)` and open with `rel="noopener noreferrer"`.
- **Same-origin rule:** the API refuses browser requests from other websites (403).
- **Analytics:** Google Analytics loads only after **Accept** on the cookie banner. Page views use generic titles with event IDs removed. Google signals and ad personalisation are off in code. Outbound-click tracking is off in the GA property, and a live test on October 2, 2026 found no event names or IDs reaching Google.

### Hosting and build
- Only the files listed in `scripts/build.mjs` are published, plus the functions in `api/`.
- The build writes only the Clerk publishable key into `config.js` and refuses anything that looks like a secret key. The Clerk secret key, Turso token, cron secret, SerpApi key and Resend key are read only by the functions.

## History

- **October 1, 2026:** first audit, of the original Supabase setup. Fixed then: third-party fonts and libraries, the profile photo, download and delete, the policy pages, security headers, unused email/password sign-up, CORS, the policy placeholders (GiftingSmart, giftingsmartshopper@gmail.com, Ontario), and a price-check rate limit.
- **October 2, 2026:** security review (no high or medium findings) and Google Analytics behind a consent banner.
- **October 4, 2026:** moved from Supabase to Clerk, Turso and Vercel Functions. Supabase's row-level security was replaced by per-user scoping in the API, covered by tests.
- **October 15, 2026:** added the SerpApi price provider, opt-in email alerts through Resend, and the 12-month retention job. Rewrote this audit for the current setup.

## Open items

1. **Have the policies reviewed** by a lawyer familiar with Canadian privacy law, and Quebec's Law 25 if there will be users there. The new US providers (SerpApi, Resend) add cross-border transfers worth covering.
2. **Before switching on SerpApi or Resend in Vercel:** check each provider's data processing terms, verify the sending domain (giftingsmart.shop) in Resend, and redeploy so the policy pages pick up the new provider rows.
3. **Keep policies in sync:** when adding a provider or a new kind of data, update the privacy and cookie pages and change `SITE.updated` in `scripts/build.mjs`.

Accepted risks: `style-src 'unsafe-inline'` (used for bar widths; no user data reaches styles), and account deletion confirmed by typing DELETE rather than signing in again.
