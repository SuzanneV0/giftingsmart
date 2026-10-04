# Privacy audit: GiftingSmart

> **Update, October 4, 2026:** GiftingSmart has since moved off Supabase. Sign-in is now Clerk (Google only, loaded only when someone signs in or is already signed in), data is in a Turso database behind the app's own API, and the price checker runs as a Vercel Function triggered by cron-job.org. The findings below describe the Supabase setup as audited on October 1; the current setup is in the README and the privacy policy.

**Date:** October 1, 2026
**Scope:** the live site (giftingsmart.shop, formerly gift-budget.vercel.app), the browser code, the Supabase project *GiftingSmart* (database, auth, Edge Functions, cron) and the Vercel project *gift-budget*.
**Framework:** Canada's PIPEDA fair information principles, plus general good practice (GDPR-style data minimisation and user rights).

This is a technical audit, not legal advice. Have a lawyer review the policies before relying on them, especially once the placeholders (name, contact email, province) are filled in.

## Summary

| | Finding | Status |
|---|---|---|
| 1 | Third parties learned of every visit: Google Fonts and jsDelivr (app library) | **Fixed**: fonts and library self-hosted |
| 2 | Google profile photo loaded from Google on every page view | **Fixed**: initials shown instead; photo never requested |
| 3 | No way to download or delete your data | **Fixed**: "Download my data" and "Delete my account" |
| 4 | No privacy policy, cookie policy, terms or legal notice | **Fixed**: five pages added, linked in the footer and at sign-in |
| 5 | Security headers allowed more than needed | **Fixed**: stricter CSP (self + Supabase only), HSTS, COOP |
| 6 | Names of other people (gift recipients) collected | **Mitigated**: hint to use a first name or nickname; policy covers it |
| 7 | Email/password sign-up enabled in Supabase but unused | **Fixed**: email provider turned off |
| 8 | Data stored in the US (cross-border transfer) | **Disclosed** in the privacy policy, as PIPEDA requires |
| 9 | Policy placeholders: name, contact email, province | **Fixed**: GiftingSmart, giftingsmartshopper@gmail.com, Ontario |
| 10 | Edge Functions accept requests from any website (CORS `*`) | **Fixed**: only giftingsmart.shop (and localhost) may call them from a browser; others get 403 |
| 11 | No limit on user-triggered price checks | **Fixed**: 20 per account per 10 minutes, enforced in the database |

## What personal information exists, and where

| Data | Source | Stored in | Who can read it |
|---|---|---|---|
| Name, email, Google ID, profile photo URL | Google sign-in | Supabase Auth (`auth.users`) | You; service role (server functions) |
| Events, people (names, budgets), gifts, prices paid, links | You | Supabase Postgres | You only (row-level security) |
| Price history and price alerts | `check-prices` function | Supabase Postgres | You only (read), server (write) |
| Sign-in session token | Supabase Auth | Your browser (localStorage) | Your browser |
| Preferences (theme, currency, alert settings) | You | Your browser (localStorage) | Your browser |
| Server logs (IP, user agent, URL, time) | Automatic | Vercel and Supabase | Providers, for operations/security |

No advertising. Google Analytics (added October 2, 2026) loads only after a visitor clicks **Accept** on the cookie banner; before that, no cookies are set and all requests go to the site itself or to Supabase. Page views are sent with generic titles and with event IDs removed, so no event, gift or people names reach Google. "Cookie settings" in the footer reopens the banner, and declining removes the `_ga` cookies. Google signals and ad personalisation are disabled in code, Enhanced measurement's **Outbound clicks** is turned off in the GA property (so gift store links aren't sent), and a live test confirmed no event names or IDs reach Google.

## Checks performed

### Database (Supabase)
- **Row-level security** is on for all five tables (`events`, `recipients`, `gifts`, `price_history`, `notifications`), and every policy limits rows to `auth.uid() = user_id`. Tested: an anonymous request sees 0 rows and cannot insert.
- **Ownership trigger** stops a user from attaching people or gifts to someone else's event.
- **Deletion cascades:** every table references `auth.users` with `ON DELETE CASCADE` (verified in `pg_constraint`), so deleting the account removes all of that user's rows.
- **Server-only writes:** users can't write price history or alerts; only the `check-prices` function (service role) can.
- **Supabase security advisor:** no findings for the database. The only warning is "leaked password protection", which applies to email/password sign-in (see finding 7).

### Server functions
- `check-prices`: accepts either a signed-in user's token (and then only touches that user's gifts) or the cron secret, which is stored in Vault and verified by the database. Tested: no token, a bad token and a wrong secret are all refused (401).
- `delete-account` (new): deletes only the account of the signed-in caller, and requires an explicit `confirm: true`. Tested: no token and a bad token give 401; missing confirmation gives 400.

### Browser
- **Third-party requests:** previously Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`), jsDelivr (`cdn.jsdelivr.net`) and Google image servers (`googleusercontent.com`). Each request revealed the visitor's IP address and the page to that company. Now everything is served from the site itself, apart from Supabase API calls.
- **Content Security Policy:** `default-src 'self'`; scripts, fonts and images only from the site; network calls only to Supabase; no plugins, no framing. Inline scripts aren't allowed.
- **XSS:** user-entered text is HTML-escaped everywhere it's displayed; gift links must start with http(s) and open with `rel="noopener noreferrer"`, so stores don't learn which page you came from.
- **Storage:** documented in full on the Cookie policy page. All items are strictly necessary for features the user asked for.
- **Notifications:** browser notifications are opt-in and require the browser's own permission prompt.

### Sign-in (Google OAuth)
- Requests only the default `openid email profile` scopes. No access to Gmail, contacts, Drive, etc.
- Uses the PKCE flow; the one-time code is removed from the address bar after sign-in.

### Hosting (Vercel)
- Only the files the build copies are published (no README, migrations or server code; verified that `/README.md` and migration URLs return 404).
- The Supabase **secret and service role keys are never published**: the build refuses to write anything except the URL and publishable key.

## Your action items

Items 1 to 3 were completed on October 1, 2026 (details filled in, email sign-up turned off, consent screen links updated to giftingsmart.shop).

1. **Fill in the placeholders.** In `scripts/build.mjs`, set `SITE.operator` (your name), `SITE.email` (a contact address; a dedicated one like privacy@ is best) and `SITE.province`. Push, and every page updates.
2. **Turn off email/password sign-up in Supabase:** Dashboard → Authentication → Sign In / Providers → **Email** → disable. The app only uses Google, but while Email is enabled, anyone with the public API key could create an email/password account directly through the API.
3. **Google OAuth consent screen:** add links to `https://giftingsmart.shop/privacy` and `/terms`, and the app's home page. Google requires these to publish the app beyond test users.
4. **Have the policies reviewed** by a lawyer familiar with Canadian privacy law (and Quebec's Law 25 if you'll have users there).
5. **Keep policies in sync:** if you add analytics, email alerts, a real price API or a new provider, update the privacy and cookie pages first and change `SITE.updated`.

## Optional hardening (low priority)
- When a real price API is connected, send it only the gift's store link (never your name, email or the recipient's name), and add the provider to the privacy policy's provider table.
- Consider a data-retention job that removes price history older than, say, 12 months for gifts that were bought long ago.

## Security review (October 2, 2026)

A full review of the database rules, Edge Functions, browser code and deployment settings. No high or medium severity issues were found. Fixed:

| # | Finding | Fix |
|---|---|---|
| S1 | A gift could be linked to another account's person (data integrity; IDs are unguessable and nothing was readable) | Ownership trigger now also requires the person to belong to the gift's event |
| S2 | Default table grants gave `anon`/`authenticated` every privilege, with RLS as the only guard | Least-privilege grants: `anon` has none; signed-in users can only read price history, read/delete alerts and update only `read` |
| S3 | `events.notes`, `gifts.url`, alert text and price source had no length limit | Length check constraints (2,000 / 2,048 / 500 / 40) |
| S4 | `check-prices` returned internal database error text | Generic error to the client, details in function logs |
| S5 | Edge Functions imported `supabase-js@2` (floating) | Pinned to 2.117.2, matching `vendor/supabase.js` |

Verified after the fix (as the `authenticated` role, rolled back): add person, add gift, mark bought, mark alert read and delete an event all work; cross-account link, editing alert text, writing price history, reading the rate-limit table and signed-out table access are all blocked.

Accepted: `style-src 'unsafe-inline'` (style attributes for bar widths; no user data reaches styles); account deletion confirmed by typing DELETE rather than re-authenticating; Supabase's leaked-password warning (no passwords are used).

**Note for future tables:** Supabase grants new tables to `anon` and `authenticated` by default. When adding a table, enable RLS and revoke what the app doesn't need, as in `20261001000100_security_hardening.sql`.
