// Data layer. Two interchangeable stores with the same async API:
//   ServerStore: real accounts (Google sign-in through Clerk), with data in the
//                Turso database behind the app's own API (api/ on Vercel)
//   LocalStore:  demo mode kept in this browser's localStorage, used when
//                config.js has no Clerk key yet
import { mockPrice, detectAlert, round2 } from '../shared/pricing.js';

// Set when a visitor chooses "Try the demo" on the live site: the app then
// runs on sample data kept in this browser instead of the real database.
const DEMO_FLAG = 'giftbudget-demo-mode';

function readDemoFlag() {
  try {
    return localStorage.getItem(DEMO_FLAG) === 'on';
  } catch {
    return false;
  }
}

export function enterDemo() {
  try {
    localStorage.setItem(DEMO_FLAG, 'on');
  } catch {
    /* storage blocked: the demo can't persist, so it just won't start */
  }
}

export function exitDemo() {
  try {
    localStorage.removeItem(DEMO_FLAG);
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* ignore */
  }
}

export async function createStore(config) {
  const configured = !!config.clerkPublishableKey;
  if (configured && readDemoFlag()) {
    const demo = new LocalStore();
    demo.visitorDemo = true; // live site, visitor chose the demo
    return demo;
  }
  if (configured) {
    const store = new ServerStore(config.clerkPublishableKey);
    // Clerk is only contacted when it's needed: a returning signed-in visitor, or a click on
    // "Continue with Google". Everyone else's visits never reach a third party.
    if (hasSignedInCookie() || signInStarted() || /[?&#]__clerk|sso-callback/.test(location.href)) await store.ensureClerk();
    return store;
  }
  return new LocalStore();
}

// Set when someone opens the sign-in window, so Clerk loads again when Google sends them back
// (before Clerk's own cookie exists) and can finish signing them in. Cleared once signed in.
const SIGNING_IN = 'giftbudget-signing-in';
function signInStarted() {
  try {
    return sessionStorage.getItem(SIGNING_IN) === '1';
  } catch {
    return false;
  }
}
function setSigningIn(on) {
  try {
    if (on) sessionStorage.setItem(SIGNING_IN, '1');
    else sessionStorage.removeItem(SIGNING_IN);
  } catch {
    /* storage blocked: sign-in still works within this page */
  }
}

// Clerk keeps a first-party "__client_uat" cookie: 0 when signed out, a timestamp when signed in.
function hasSignedInCookie() {
  return document.cookie.split('; ').some((c) => {
    const [name, value] = c.split('=');
    return name.startsWith('__client_uat') && value && value !== '0';
  });
}

function loadScript(src, attrs = {}) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = resolve;
    s.onerror = () => reject(new Error('The sign-in service didn’t load. Check your connection or ad blocker, then reload.'));
    document.head.append(s);
  });
}

// Clerk's browser library and sign-in window load from the app's Clerk host, which is encoded
// in the publishable key.
async function loadClerk(publishableKey) {
  const host = atob(publishableKey.split('_').pop()).replace(/\$$/, '');
  await loadScript(`https://${host}/npm/@clerk/ui@1/dist/ui.browser.js`);
  await loadScript(`https://${host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, { 'data-clerk-publishable-key': publishableKey });
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  return window.Clerk;
}

const byDate = (key) => (a, b) => new Date(a[key]) - new Date(b[key]);

function normalizeEvent(e) {
  e.recipients = (e.recipients ?? []).sort(byDate('created_at'));
  e.gifts = (e.gifts ?? []).sort(byDate('created_at'));
  for (const g of e.gifts) g.price_history = (g.price_history ?? []).sort(byDate('checked_at'));
  return e;
}

// ---------------------------------------------------------------------------

class ServerStore {
  constructor(publishableKey) {
    this.publishableKey = publishableKey;
    this.clerk = null;
    this.loading = null;
    this.authListeners = [];
    this.demo = false;
  }

  /** Loads Clerk once, and hands it any auth listeners registered before it arrived. */
  async ensureClerk() {
    if (!this.loading) {
      this.loading = loadClerk(this.publishableKey).then((clerk) => {
        this.clerk = clerk;
        if (clerk.user) setSigningIn(false);
        let last = clerk.user?.id ?? null;
        clerk.addListener(({ user }) => {
          const id = user?.id ?? null;
          if (id === last) return;
          last = id;
          if (id) setSigningIn(false);
          for (const cb of this.authListeners) cb(user ? toUser(user) : null);
        });
        return clerk;
      }).catch((e) => { this.loading = null; throw e; });
    }
    return this.loading;
  }

  async getUser() {
    return this.clerk?.user ? toUser(this.clerk.user) : null;
  }

  onAuthChange(cb) {
    this.authListeners.push(cb);
  }

  // Opens Clerk's sign-in window. Google is the only option, and new visitors get an account
  // automatically, so it behaves like the old "Continue with Google".
  async signInWithGoogle() {
    const clerk = await this.ensureClerk();
    setSigningIn(true);
    clerk.openSignIn({ withSignUp: true, forceRedirectUrl: location.origin + location.pathname + location.hash });
  }

  async signOut() {
    await this.clerk?.signOut();
  }

  async request(path, payload) {
    const token = await this.clerk?.session?.getToken();
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async call(op, ...args) {
    return (await this.request('/api/store', { op, args })).result;
  }

  /** Everything stored about the signed-in user, for "Download my data". */
  async exportData() {
    const u = this.clerk?.user;
    const data = await this.call('exportData');
    return {
      account: u && {
        id: u.id,
        email: u.primaryEmailAddress?.emailAddress ?? null,
        created_at: u.createdAt,
        last_sign_in_at: u.lastSignInAt,
        name: u.fullName,
      },
      ...data,
    };
  }

  /** Permanently deletes the account and all its data (server-side). */
  async deleteAccount() {
    await this.request('/api/delete-account', { confirm: true });
    await this.clerk?.signOut().catch(() => {});
  }

  async listEvents() {
    return (await this.call('listEvents')).map(normalizeEvent);
  }

  async getEvent(id) {
    const e = await this.call('getEvent', id);
    return e && normalizeEvent(e);
  }

  createEvent(event, recipients) {
    return this.call('createEvent', event, recipients);
  }

  updateEvent(id, patch) {
    return this.call('updateEvent', id, patch);
  }

  deleteEvent(id) {
    return this.call('deleteEvent', id);
  }

  addRecipient(eventId, recipient) {
    return this.call('addRecipient', eventId, recipient);
  }

  updateRecipient(id, patch) {
    return this.call('updateRecipient', id, patch);
  }

  deleteRecipient(id) {
    return this.call('deleteRecipient', id);
  }

  async addGift(eventId, gift) {
    const data = await this.call('addGift', eventId, gift);
    // Record a first price point right away so tracking starts now.
    if (data.track_price) await this.checkPrices({ gift_id: data.id }).catch(() => {});
    return data;
  }

  updateGift(id, patch) {
    return this.call('updateGift', id, patch);
  }

  deleteGift(id) {
    return this.call('deleteGift', id);
  }

  async checkPrices(scope) {
    try {
      return await this.request('/api/check-prices', scope ?? {});
    } catch (err) {
      if (err.status === 429) throw new Error('You’ve checked prices a lot in the last few minutes. Please try again shortly.');
      throw err;
    }
  }

  listNotifications() {
    return this.call('listNotifications');
  }

  getSettings() {
    return this.call('getSettings');
  }

  updateSettings(patch) {
    return this.call('updateSettings', patch);
  }

  async markNotificationsRead(ids) {
    if (!ids.length) return;
    await this.call('markNotificationsRead', ids);
  }
}

function toUser(u) {
  const email = u.primaryEmailAddress?.emailAddress ?? '';
  return {
    id: u.id,
    email,
    name: u.fullName || email,
    avatar: null, // the profile photo is never loaded; the app shows initials
    provider: 'google',
    created_at: u.createdAt ? new Date(u.createdAt).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------

const LOCAL_KEY = 'giftbudget-demo-v1';
const SIX_HOURS = 6 * 60 * 60 * 1000;

class LocalStore {
  constructor() {
    this.demo = true;
    this.listeners = [];
    this.data = this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      /* storage blocked or corrupt: start empty */
    }
    return emptyData();
  }

  save() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(this.data));
    } catch {
      /* keep working in memory */
    }
  }

  async getUser() {
    return this.data.user;
  }

  onAuthChange(cb) {
    this.listeners.push(cb);
  }

  emit() {
    for (const cb of this.listeners) cb(this.data.user);
  }

  // In local development (no Clerk key), "Continue with Google" starts the demo.
  async signInWithGoogle() {
    await this.startDemo();
  }

  /** Signs in as a local demo user with sample events. */
  async startDemo() {
    this.data = emptyData();
    this.data.user = {
      id: 'demo-user',
      email: 'demo@example.com',
      name: 'Demo user',
      avatar: null,
      provider: 'demo',
      created_at: new Date().toISOString(),
    };
    seedDemo(this);
    this.save();
    this.emit();
  }

  async signOut() {
    this.data = emptyData();
    this.save();
    this.emit();
  }

  async exportData() {
    const { user, events, recipients, gifts, price_history, notifications } = this.data;
    return { account: user, events, recipients, gifts, price_history, notifications };
  }

  async deleteAccount() {
    try {
      localStorage.removeItem(LOCAL_KEY);
    } catch {
      /* ignore */
    }
    await this.signOut();
  }

  assemble(e, withHistory) {
    const d = this.data;
    return normalizeEvent({
      ...e,
      recipients: d.recipients.filter((r) => r.event_id === e.id).map((r) => ({ ...r })),
      gifts: d.gifts
        .filter((g) => g.event_id === e.id)
        .map((g) => ({
          ...g,
          price_history: withHistory ? d.price_history.filter((h) => h.gift_id === g.id) : undefined,
        })),
    });
  }

  async listEvents() {
    return this.data.events
      .map((e) => this.assemble(e, false))
      .sort((a, b) => (a.event_date || '9999').localeCompare(b.event_date || '9999'));
  }

  async getEvent(id) {
    const e = this.data.events.find((x) => x.id === id);
    return e ? this.assemble(e, true) : null;
  }

  async createEvent(event, recipients) {
    const row = { id: uid(), created_at: now(), notes: null, ...event };
    this.data.events.push(row);
    for (const r of recipients) this.data.recipients.push({ id: uid(), created_at: now(), ...r, event_id: row.id });
    this.save();
    return row;
  }

  async updateEvent(id, patch) {
    Object.assign(this.data.events.find((e) => e.id === id), patch);
    this.save();
  }

  async deleteEvent(id) {
    const d = this.data;
    const giftIds = new Set(d.gifts.filter((g) => g.event_id === id).map((g) => g.id));
    d.events = d.events.filter((e) => e.id !== id);
    d.recipients = d.recipients.filter((r) => r.event_id !== id);
    d.gifts = d.gifts.filter((g) => g.event_id !== id);
    d.price_history = d.price_history.filter((h) => !giftIds.has(h.gift_id));
    d.notifications = d.notifications.filter((n) => n.event_id !== id);
    this.save();
  }

  async addRecipient(eventId, recipient) {
    this.data.recipients.push({ id: uid(), created_at: now(), ...recipient, event_id: eventId });
    this.save();
  }

  async updateRecipient(id, patch) {
    Object.assign(this.data.recipients.find((r) => r.id === id), patch);
    this.save();
  }

  async deleteRecipient(id) {
    this.data.recipients = this.data.recipients.filter((r) => r.id !== id);
    for (const g of this.data.gifts) if (g.recipient_id === id) g.recipient_id = null;
    this.save();
  }

  async addGift(eventId, gift) {
    const row = {
      id: uid(),
      created_at: now(),
      status: 'wanted',
      amount_spent: null,
      bought_at: null,
      last_checked_at: null,
      ...gift,
      event_id: eventId,
    };
    this.data.gifts.push(row);
    if (row.track_price) this.recordPrice(row, this.data.clock);
    this.save();
    return row;
  }

  async updateGift(id, patch) {
    Object.assign(this.data.gifts.find((g) => g.id === id), patch);
    this.save();
  }

  async deleteGift(id) {
    this.data.gifts = this.data.gifts.filter((g) => g.id !== id);
    this.data.price_history = this.data.price_history.filter((h) => h.gift_id !== id);
    this.data.notifications = this.data.notifications.filter((n) => n.gift_id !== id);
    this.save();
  }

  // Demo price check: each click moves a simulated clock forward six hours,
  // so repeated checks show the price moving and sales appearing.
  async checkPrices({ event_id, gift_id } = {}) {
    this.data.clock += SIX_HOURS;
    let checked = 0;
    let alerts = 0;
    for (const g of this.data.gifts) {
      if (!g.track_price || g.status !== 'wanted') continue;
      if (event_id && g.event_id !== event_id) continue;
      if (gift_id && g.id !== gift_id) continue;
      if (this.recordPrice(g, this.data.clock)) alerts++;
      checked++;
    }
    this.save();
    return { checked, alerts, provider: 'mock' };
  }

  recordPrice(gift, at) {
    const history = this.data.price_history.filter((h) => h.gift_id === gift.id);
    const base = Number(history[0]?.price ?? gift.current_price ?? 0);
    const price = mockPrice(gift.id, base, at);
    const alert = detectAlert(gift, history, price, at);
    const checked_at = new Date(at).toISOString();
    this.data.price_history.push({ id: uid(), gift_id: gift.id, price, source: 'mock', checked_at });
    gift.current_price = price;
    gift.last_checked_at = checked_at;
    if (alert) {
      this.data.notifications.push({
        id: uid(),
        gift_id: gift.id,
        event_id: gift.event_id,
        kind: alert.kind,
        message: alert.message,
        read: false,
        created_at: now(),
      });
    }
    return !!alert;
  }

  async listNotifications() {
    return [...this.data.notifications].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
  }

  async markNotificationsRead(ids) {
    for (const n of this.data.notifications) if (ids.includes(n.id)) n.read = true;
    this.save();
  }

  // The demo never sends email.
  async getSettings() {
    return { email_alerts: false, email_available: false };
  }

  async updateSettings() {}
}

function emptyData() {
  return { user: null, events: [], recipients: [], gifts: [], price_history: [], notifications: [], clock: Date.now() };
}

function uid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

// A sample event so the demo isn't empty, with a couple of weeks of history.
function seedDemo(store) {
  const d = store.data;
  const year = new Date().getFullYear();
  const xmas = {
    id: uid(),
    name: `Holiday gifts ${year}`,
    event_date: `${year}-12-25`,
    budget_mode: 'per_recipient',
    total_budget: null,
    notes: null,
    created_at: now(),
  };
  d.events.push(xmas);
  const people = [
    { name: 'Mom', budget: 150 },
    { name: 'Dad', budget: 120 },
    { name: 'Lauren', budget: 80 },
  ].map((p) => ({ id: uid(), created_at: now(), event_id: xmas.id, ...p }));
  d.recipients.push(...people);

  const gifts = [
    { name: 'Cashmere scarf', recipient: 0, price: 89, status: 'bought', spent: 79.5 },
    { name: 'Espresso machine', recipient: 1, price: 119, target: 99 },
    { name: 'LEGO Botanical bouquet', recipient: 2, price: 59.99 },
    { name: 'Hardcover cookbook', recipient: 0, price: 35 },
    { name: 'Wool socks (3-pack)', recipient: 1, price: 24 },
  ];
  const start = d.clock - 14 * 4 * SIX_HOURS;
  for (const g of gifts) {
    const row = {
      id: uid(),
      created_at: now(),
      event_id: xmas.id,
      recipient_id: people[g.recipient].id,
      name: g.name,
      url: null,
      current_price: g.price,
      target_price: g.target ?? null,
      track_price: g.status !== 'bought',
      status: g.status ?? 'wanted',
      amount_spent: g.spent ?? null,
      bought_at: g.status === 'bought' ? now() : null,
      last_checked_at: null,
    };
    d.gifts.push(row);
    if (!row.track_price) continue;
    for (let t = start; t <= d.clock; t += SIX_HOURS * 4) {
      const history = d.price_history.filter((h) => h.gift_id === row.id);
      const base = Number(history[0]?.price ?? g.price);
      const price = round2(mockPrice(row.id, base, t));
      d.price_history.push({ id: uid(), gift_id: row.id, price, source: 'mock', checked_at: new Date(t).toISOString() });
      row.current_price = price;
      row.last_checked_at = new Date(t).toISOString();
    }
  }

  const bday = {
    id: uid(),
    name: "Jane's baby shower",
    event_date: `${year + 1}-02-14`,
    budget_mode: 'total',
    total_budget: 60,
    notes: null,
    created_at: now(),
  };
  d.events.push(bday);
}
