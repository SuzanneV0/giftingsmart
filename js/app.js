import { createStore, enterDemo, exitDemo } from './store.js';
import * as B from './budget.js';
import { isOnSale } from '../shared/pricing.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const dialog = document.getElementById('dialog');
const toastEl = document.getElementById('toast');

let store;
let user = null;
let notifications = [];

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pref = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'NZD'];
let currency = pref.get('giftbudget-currency', 'CAD');
let moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
const money = (n) => (n == null ? '—' : moneyFmt.format(Number(n)));

function parseMoney(v) {
  const s = String(v ?? '').replace(/[^0-9.]/g, '');
  if (!s) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function countdown(d) {
  if (!d) return '';
  const days = Math.round((new Date(d + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 0) return `In ${days} days`;
  return days === -1 ? 'Yesterday' : `${-days} days ago`;
}

function toast(msg, kind = 'info') {
  toastEl.textContent = msg;
  toastEl.dataset.kind = kind;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 3500);
}

function go(path) {
  if (location.hash === '#' + path) render();
  else location.hash = path;
}

function fail(e) {
  console.error(e);
  toast(e?.message || 'Something went wrong. Please try again.', 'error');
}

// ---------------------------------------------------------------- modal

function openModal(html, mount) {
  dialog.innerHTML = `<form method="dialog" class="modal" novalidate>${html}</form>`;
  const form = dialog.querySelector('form');
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      e.preventDefault();
      dialog.close();
    }
  });
  mount?.(form);
  dialog.showModal();
  form.querySelector('[autofocus]')?.focus();
  return form;
}

function confirmModal({ title, body, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const form = openModal(`
      <h2>${esc(title)}</h2>
      <p>${body}</p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(confirm)}</button>
      </div>`);
    let ok = false;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      ok = true;
      dialog.close();
    });
    dialog.addEventListener('close', () => resolve(ok), { once: true });
  });
}

// ---------------------------------------------------------------- UI bits

function progressBar({ budget, spent, planned, state }, { size = 'lg', showPlanned = true } = {}) {
  if (budget == null) {
    return `<div class="bar ${size} none"><div class="bar-fill" style="width:0"></div></div>`;
  }
  const scale = Math.max(budget, spent + (showPlanned ? planned : 0), 0.01);
  const spentPct = Math.min(100, (spent / scale) * 100);
  const plannedPct = showPlanned ? Math.min(100 - spentPct, (planned / scale) * 100) : 0;
  const markPct = (budget / scale) * 100;
  return `
    <div class="bar ${size} ${state}" role="progressbar" aria-valuemin="0" aria-valuemax="${budget}"
         aria-valuenow="${spent.toFixed(2)}" aria-label="${esc(money(spent))} spent of ${esc(money(budget))}">
      <div class="bar-fill" style="width:${spentPct}%"></div>
      ${plannedPct > 0 ? `<div class="bar-planned" style="left:${spentPct}%;width:${plannedPct}%"></div>` : ''}
      ${markPct < 99.5 ? `<div class="bar-limit" style="left:${markPct}%" title="Budget"></div>` : ''}
    </div>`;
}

function sparkline(history) {
  if (!history || history.length < 2) return '';
  const w = 84;
  const h = 26;
  const prices = history.map((p) => Number(p.price));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const pts = prices
    .map((p, i) => `${((i / (prices.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((p - min) / span) * (h - 6)).toFixed(1)}`)
    .join(' ');
  const last = pts.split(' ').pop().split(',');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"
      aria-label="Price history: low ${esc(money(min))}, high ${esc(money(max))}">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.4" fill="currentColor"/>
  </svg>`;
}

// Initials only: loading the Google profile photo would tell Google about
// every page view, so the app never requests it.
function avatar(u, size = 32) {
  const initial = (u.name || u.email || '?').trim()[0].toUpperCase();
  return `<span class="avatar" style="width:${size}px;height:${size}px" aria-hidden="true">${esc(initial)}</span>`;
}

// ---------------------------------------------------------------- nav

const ICONS = {
  moon: '<svg class="icon-moon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  sun: '<svg class="icon-sun" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

// ---------------------------------------------------------------- theme

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/** The saved choice: 'light', 'dark' or 'system'. */
function themeChoice() {
  const t = pref.get('giftbudget-theme', 'system');
  return t === 'light' || t === 'dark' ? t : 'system';
}

function effectiveTheme() {
  const t = themeChoice();
  return t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t;
}

function setTheme(choice) {
  if (choice === 'system') {
    document.documentElement.removeAttribute('data-theme');
    try {
      localStorage.removeItem('giftbudget-theme');
    } catch {
      /* ignore */
    }
  } else {
    document.documentElement.setAttribute('data-theme', choice);
    pref.set('giftbudget-theme', choice);
  }
  updateThemeLabels();
}

function toggleTheme() {
  setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
}

function updateThemeLabels() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
    b.setAttribute('aria-label', `Switch to ${next} mode`);
    b.title = `Switch to ${next} mode`;
    const text = b.querySelector('.theme-text');
    if (text) text.textContent = next === 'dark' ? 'Dark mode' : 'Light mode';
  });
  const select = document.getElementById('theme-select');
  if (select) select.value = themeChoice();
}

darkQuery.addEventListener('change', updateThemeLabels);

// ---------------------------------------------------------------- nav

function renderNav() {
  const route = location.hash.slice(1) || '/';
  const current = (href) => (route === href ? 'aria-current="page"' : '');
  const link = (href, label) => `<a href="#${href}" class="nav-link" ${current(href)}>${label}</a>`;
  const menuLink = (href, label) => `<a href="#${href}" ${current(href)}>${label}</a>`;
  const unread = notifications.filter((n) => !n.read).length;
  const themeBtn = `<button class="icon-btn theme-btn" data-theme-toggle>${ICONS.moon}${ICONS.sun}</button>`;
  const menuBtn = `<button class="icon-btn menu-btn" id="menu-btn" aria-label="Menu" aria-expanded="false" aria-controls="menu">${ICONS.menu}</button>`;
  const menuTheme = `<hr><button data-theme-toggle class="theme-btn">${ICONS.moon}${ICONS.sun}<span class="theme-text"></span></button>`;

  nav.innerHTML = `
    <a href="#/" class="brand" aria-label="GiftingSmart home">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><use href="#logo"/></svg>
      <span>GiftingSmart</span>
    </a>
    ${
      user
        ? `<nav class="nav-links" aria-label="Main">
            ${link('/events', 'My events')}
            ${link('/events/new', 'New event')}
          </nav>
          <div class="nav-right">
            ${themeBtn}
            <button class="icon-btn bell" id="bell" aria-label="Price alerts${unread ? `, ${unread} unread` : ''}" aria-expanded="false">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.6L4.3 15.4A1 1 0 0 0 5.2 17h13.6a1 1 0 0 0 .9-1.6L18 12.6V9a6 6 0 0 0-6-6Zm-2.5 15a2.5 2.5 0 0 0 5 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              ${unread ? `<span class="badge">${unread > 9 ? '9+' : unread}</span>` : ''}
            </button>
            <a href="#/account" class="account-link" ${current('/account')}>
              ${avatar(user, 30)}<span class="account-name">My account</span>
            </a>
            ${menuBtn}
          </div>
          <div class="alerts-panel" id="alerts" hidden></div>
          <div class="menu-panel" id="menu" hidden>
            <nav aria-label="Menu">
              ${menuLink('/events', 'My events')}
              ${menuLink('/events/new', 'New event')}
              ${menuLink('/account', 'My account')}
            </nav>
            ${menuTheme}
          </div>`
        : `<div class="nav-right">
            ${themeBtn}
            <a href="#/login" class="btn primary sm">Log in / Sign up</a>
            ${menuBtn}
          </div>
          <div class="menu-panel" id="menu" hidden>
            <nav aria-label="Menu">
              ${menuLink('/', 'Home')}
              <a href="/about">About us</a>
              ${store.demo ? '' : '<button type="button" data-start-demo>Try the demo</button>'}
            </nav>
            ${menuTheme}
          </div>`
    }`;

  nav.querySelector('#bell')?.addEventListener('click', toggleAlerts);
  nav.querySelector('#menu-btn').addEventListener('click', () => setMenu(nav.querySelector('#menu').hidden));
  nav.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
  nav.querySelectorAll('#menu a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
  updateThemeLabels();
}

function setMenu(open) {
  const menu = nav.querySelector('#menu');
  const btn = nav.querySelector('#menu-btn');
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
  btn.innerHTML = open ? ICONS.close : ICONS.menu;
  if (open) {
    const alerts = nav.querySelector('#alerts');
    if (alerts) alerts.hidden = true;
  }
}

document.addEventListener('keydown', (e) => {
  const menu = nav.querySelector('#menu');
  if (e.key === 'Escape' && menu && !menu.hidden) {
    setMenu(false);
    nav.querySelector('#menu-btn')?.focus();
  }
});

function toggleAlerts() {
  const panel = nav.querySelector('#alerts');
  const bell = nav.querySelector('#bell');
  const open = panel.hidden;
  panel.hidden = !open;
  bell.setAttribute('aria-expanded', String(open));
  if (!open) return;
  panel.innerHTML = `
    <h2>Price alerts</h2>
    ${
      notifications.length
        ? `<ul>${notifications
            .map(
              (n) => `<li class="${n.read ? '' : 'unread'}">
                <a href="#/events/${esc(n.event_id)}">
                  <span class="alert-kind ${esc(n.kind)}">${n.kind === 'target' ? 'Target price' : 'Sale'}</span>
                  ${esc(n.message)}
                  <time>${new Date(n.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                </a></li>`,
            )
            .join('')}</ul>`
        : `<p class="muted">No alerts yet. We'll let you know here when something on your lists goes on sale.</p>`
    }`;
  panel.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => (panel.hidden = true)));
  const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
  if (unreadIds.length) {
    store.markNotificationsRead(unreadIds).then(() => {
      notifications.forEach((n) => (n.read = true));
      nav.querySelector('.bell .badge')?.remove();
    }, fail);
  }
}

document.addEventListener('click', (e) => {
  const menu = nav.querySelector('#menu');
  if (menu && !menu.hidden && !e.target.closest('#menu, #menu-btn')) setMenu(false);
  const panel = nav.querySelector('#alerts');
  if (panel && !panel.hidden && !e.target.closest('#alerts, #bell')) {
    panel.hidden = true;
    nav.querySelector('#bell')?.setAttribute('aria-expanded', 'false');
  }
});

async function refreshNotifications() {
  if (!user) return;
  try {
    notifications = await store.listNotifications();
  } catch (e) {
    console.error(e);
    return;
  }
  notifyBrowser();
  const panel = nav.querySelector('#alerts');
  if (!panel || panel.hidden) renderNav();
}

// Show a system notification for unread alerts we haven't shown before.
function notifyBrowser() {
  if (pref.get('giftbudget-browser-alerts', 'off') !== 'on') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  let shown;
  try {
    shown = new Set(JSON.parse(pref.get('giftbudget-shown-alerts', '[]')));
  } catch {
    shown = new Set();
  }
  for (const n of notifications) {
    if (n.read || shown.has(n.id)) continue;
    const note = new Notification(n.kind === 'target' ? 'Target price reached' : 'Price drop', {
      body: n.message,
      tag: n.id,
      icon: 'icon.svg',
    });
    note.onclick = () => {
      window.focus();
      go(`/events/${n.event_id}`);
    };
    shown.add(n.id);
  }
  pref.set('giftbudget-shown-alerts', JSON.stringify([...shown].slice(-200)));
}

// ---------------------------------------------------------------- pages

function homePage() {
  const cta = user
    ? `<a href="#/events/new" class="btn primary lg">Plan a new event</a>
       <a href="#/events" class="btn ghost lg">My events</a>`
    : `<a href="#/login" class="btn primary lg">Get started, it's free</a>
       ${store.demo ? '' : '<button type="button" class="btn ghost lg" data-start-demo>Try the demo</button>'}`;
  return `
    <section class="hero">
      <div class="hero-text">
        <p class="eyebrow">Birthdays · Holidays · Showers · Housewarmings</p>
        <h1>Give generously.<br>Stay on budget.</h1>
        <p class="lead">Plan gifts for any occasion, set a budget for the whole event or for each person,
          and watch your spending as you shop. We'll track prices on your list and tell you when something goes on sale.</p>
        <div class="hero-cta">${cta}</div>
      </div>
      <div class="hero-card" aria-hidden="true">
        <div class="hc-title">Maya's birthday</div>
        <div class="hc-sub">$268 spent of $350 · $82 left</div>
        <div class="bar lg ok"><div class="bar-fill" style="width:62%"></div><div class="bar-planned" style="left:62%;width:22%"></div></div>
        <ul class="hc-list">
          <li><span class="tick done"></span>Cashmere scarf <b>$79.50</b></li>
          <li><span class="tick"></span>Espresso machine <span class="sale-tag">Sale −18%</span></li>
          <li><span class="tick"></span>LEGO bouquet <b>$59.99</b></li>
        </ul>
      </div>
    </section>

    <section class="how" aria-labelledby="how-title">
      <h2 id="how-title">How to get started</h2>
      <ol class="steps">
        <li><span class="step-n">1</span><h3>Sign in with Google</h3>
          <p>One click, no new password. Your events and lists are private to your account.</p></li>
        <li><span class="step-n">2</span><h3>Create an event</h3>
          <p>"Lauren's birthday", "Christmas 2026", "Jane's baby shower". Add who you're buying for.</p></li>
        <li><span class="step-n">3</span><h3>Set your budget</h3>
          <p>Choose one budget for the whole event, or a separate budget for each person.</p></li>
        <li><span class="step-n">4</span><h3>Build your list and shop</h3>
          <p>Add gift ideas with links. We track their prices and alert you to sales. Mark each one bought with what you paid.</p></li>
      </ol>
    </section>

    <section class="features" aria-label="Features">
      <div class="feature"><h3>See your spending at a glance</h3>
        <p>A progress bar at the top of every event shows what you've spent, what your list will cost, and what's left.</p></div>
      <div class="feature"><h3>Warnings before you overspend</h3>
        <p>We tell you when a purchase would take you near or over budget, before you record it.</p></div>
      <div class="feature"><h3>Price history and sale alerts</h3>
        <p>Each gift shows its recent price trend, and you get an alert when it drops or hits your target price.</p></div>
    </section>`;
}

function loginPage() {
  return `
    <section class="auth-card">
      <h1>Log in or sign up</h1>
      <p class="muted">Use your Google account. If you're new, we'll create your account automatically.</p>
      <button class="btn google lg" id="google">
        <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        Continue with Google
      </button>
      ${
        store.demo
          ? `<p class="demo-note">Demo mode: sign-in isn't connected yet, so this signs you in as a demo user and keeps
             data in this browser only. See the README to turn on real Google sign-in.</p>`
          : `<div class="or"><span>or</span></div>
             <button type="button" class="btn ghost lg demo-btn" data-start-demo>Try the demo</button>
             <p class="muted small">No account needed. Explore with sample data that stays in this browser.</p>`
      }
    <p class="muted small legal-note">By continuing, you agree to the <a href="/terms">Terms of use</a> and
        <a href="/privacy">Privacy policy</a>. We never post to your Google account or read your contacts.</p>
    </section>`;
}

function mountLogin(root) {
  root.querySelector('#google').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await store.signInWithGoogle();
    } catch (err) {
      fail(err);
    } finally {
      // The sign-in window opens over the page; if it's closed, the button should work again.
      btn.disabled = false;
    }
  });
}

function accountPage() {
  const since = user.created_at ? new Date(user.created_at).toLocaleDateString(undefined, { dateStyle: 'long' }) : '';
  const alertsOn = pref.get('giftbudget-browser-alerts', 'off') === 'on';
  const supported = 'Notification' in window;
  return `
    <h1>My account</h1>
    <section class="card profile">
      ${avatar(user, 56)}
      <div>
        <div class="profile-name">${esc(user.name)}</div>
        <div class="muted">${esc(user.email)}</div>
        <div class="muted small">Signed in with ${user.provider === 'demo' ? 'demo mode' : 'Google'}${since ? ` · member since ${esc(since)}` : ''}</div>
      </div>
    </section>

    <section class="card prefs">
      <h2>Preferences</h2>
      <label class="field">
        <span>Currency</span>
        <select id="currency">${CURRENCIES.map((c) => `<option ${c === currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
      <label class="toggle">
        <input type="checkbox" id="browser-alerts" ${alertsOn ? 'checked' : ''} ${supported ? '' : 'disabled'}>
        <span>Browser notifications for price drops${supported ? '' : ' (not supported in this browser)'}</span>
      </label>
      <p class="muted small">Price alerts always appear under the bell icon. Browser notifications also pop up while the app is open in a tab.</p>
      <label class="field">
        <span>Appearance</span>
        <select id="theme-select">
          <option value="system">Match my device</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </section>

    <section class="card">
      <h2>Your data</h2>
      <p class="muted small">Download a copy of everything GiftingSmart stores about you, or delete your account.
        See the <a href="/privacy">Privacy policy</a> for details.</p>
      <div class="head-actions">
        <button class="btn ghost" id="export">Download my data</button>
        <button class="btn ghost danger-text" id="delete-account">Delete my account</button>
      </div>
    </section>

    <section class="card">
      <h2>Session</h2>
      <button class="btn ghost" id="signout">Sign out</button>
    </section>`;
}

function mountAccount(root) {
  root.querySelector('#currency').addEventListener('change', (e) => {
    currency = e.target.value;
    moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    pref.set('giftbudget-currency', currency);
    toast(`Currency set to ${currency}`);
  });
  root.querySelector('#browser-alerts').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        e.target.checked = false;
        toast('Notifications are blocked for this site in your browser settings.', 'error');
        return;
      }
    }
    pref.set('giftbudget-browser-alerts', e.target.checked ? 'on' : 'off');
  });
  const themeSelect = root.querySelector('#theme-select');
  themeSelect.value = themeChoice();
  themeSelect.addEventListener('change', (e) => setTheme(e.target.value));
  root.querySelector('#export').addEventListener('click', exportData);
  root.querySelector('#delete-account').addEventListener('click', deleteAccountModal);
  root.querySelector('#signout').addEventListener('click', async () => {
    if (store.visitorDemo) return leaveDemo();
    await store.signOut();
    go('/');
  });
}

async function exportData() {
  try {
    const data = await store.exportData();
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), ...data }, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `giftingsmart-data-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    fail(err);
  }
}

function deleteAccountModal() {
  const form = openModal(`
    <h2>Delete your account?</h2>
    <p>This permanently deletes your account and everything in it: events, people, gifts, prices and alerts.
      It can\u2019t be undone. You might want to <button type="button" class="link-btn" id="export-first">download your data</button> first.</p>
    <label class="field">
      <span>Type <b>DELETE</b> to confirm</span>
      <input name="confirm" autocomplete="off" autocapitalize="characters" autofocus>
    </label>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn danger" id="confirm-delete" disabled>Delete my account</button>
    </div>`);
  const btn = form.querySelector('#confirm-delete');
  form.confirm.addEventListener('input', () => (btn.disabled = form.confirm.value.trim() !== 'DELETE'));
  form.querySelector('#export-first').addEventListener('click', exportData);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.confirm.value.trim() !== 'DELETE') return;
    btn.disabled = true;
    btn.textContent = 'Deleting\u2026';
    try {
      await store.deleteAccount();
      if (store.visitorDemo) return leaveDemo();
      dialog.close();
      user = null;
      notifications = [];
      toast('Your account and all its data have been deleted.');
      go('/');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Delete my account';
      fail(err);
    }
  });
}

async function eventsPage() {
  const events = await store.listEvents();
  if (!events.length) {
    return `
      <div class="page-head"><h1>My events</h1></div>
      <section class="empty">
        <h2>No events yet</h2>
        <p class="muted">Create your first gift-giving event to start a list and set a budget.</p>
        <a href="#/events/new" class="btn primary">New event</a>
      </section>`;
  }
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = events.filter((e) => !e.event_date || e.event_date >= today);
  const past = events.filter((e) => e.event_date && e.event_date < today).reverse();
  const card = (e) => {
    const s = B.summary(e);
    const bought = e.gifts.filter((g) => g.status === 'bought').length;
    return `
      <a href="#/events/${esc(e.id)}" class="event-card">
        <div class="ec-head">
          <h2>${esc(e.name)}</h2>
          ${e.event_date ? `<span class="muted small">${esc(fmtDate(e.event_date))} · ${esc(countdown(e.event_date))}</span>` : ''}
        </div>
        ${progressBar(s, { size: 'sm' })}
        <div class="ec-meta">
          <span>${s.budget == null ? `${esc(money(s.spent))} spent · no budget set` : `${esc(money(s.spent))} of ${esc(money(s.budget))}`}</span>
          <span>${bought}/${e.gifts.length} gifts bought</span>
        </div>
        ${s.state === 'over' ? `<span class="pill over">Over budget</span>` : s.state === 'near' ? `<span class="pill near">Almost at budget</span>` : ''}
      </a>`;
  };
  return `
    <div class="page-head"><h1>My events</h1><a href="#/events/new" class="btn primary">New event</a></div>
    <div class="event-grid">${upcoming.map(card).join('')}</div>
    ${past.length ? `<h2 class="section-title">Past events</h2><div class="event-grid past">${past.map(card).join('')}</div>` : ''}`;
}

// Suggested event names, covering many traditions. Holidays are labelled with
// the year of their next occurrence, using the month they usually fall in
// (approximate for lunar calendars, which shift from year to year).
const HOLIDAYS = [
  ['Christmas', 12], ['Hanukkah', 12], ['Kwanzaa', 12], ['Rosh Hashanah', 9], ['Passover', 4], ['Purim', 3],
  ['Ramadan', 2], ['Eid al-Fitr', 3], ['Eid al-Adha', 5], ['Diwali', 11], ['Holi', 3], ['Vaisakhi', 4],
  ['Lunar New Year', 2], ['Mid-Autumn Festival', 9], ['Nowruz', 3], ['Easter', 4], ['Three Kings Day', 1],
  ['St. Nicholas Day', 12], ['Vesak', 5], ["Valentine's Day", 2], ["Mother's Day", 5], ["Father's Day", 6],
  ['Secret Santa', 12],
];

function holiday(name, now = new Date()) {
  const month = HOLIDAYS.find(([n]) => n === name)[1];
  return `${name} ${month >= now.getMonth() + 1 ? now.getFullYear() : now.getFullYear() + 1}`;
}

const COMMON_OCCASIONS = () => [
  'Birthday',
  ...['Christmas', 'Hanukkah', 'Eid al-Fitr', 'Diwali', 'Lunar New Year'].map((n) => holiday(n)),
  'Baby shower',
  'Wedding',
  'Housewarming',
];

const OCCASION_GROUPS = () => [
  { title: 'Holidays and festivals', items: HOLIDAYS.map(([n]) => holiday(n)) },
  {
    title: 'Milestones and ceremonies',
    items: [
      'Birthday', 'Baby shower', 'New baby', 'Gender reveal', 'Engagement', 'Bridal shower', 'Wedding',
      'Anniversary', 'Housewarming', 'Graduation', 'Retirement', 'Bar Mitzvah', 'Bat Mitzvah', 'Baptism',
      'Christening', 'First Communion', 'Confirmation', 'Aqiqah', 'Quinceañera', 'Sweet 16', 'Coming of age',
    ],
  },
  {
    title: 'Just because',
    items: ['Thank-you gift', 'Get well soon', 'Teacher gift', 'Host gift', 'Farewell', 'Congratulations', 'Sympathy'],
  },
];

function newEventPage() {
  const chips = (list) => list.map((i) => `<button type="button" class="chip" data-idea="${esc(i)}">${esc(i)}</button>`).join('');
  return `
    <h1>New event</h1>
    <form class="card form" id="new-event" novalidate>
      <label class="field">
        <span>Event name</span>
        <input name="name" required maxlength="120" placeholder="e.g. Lauren's birthday" autocomplete="off" autofocus>
      </label>
      <div class="chips" aria-label="Suggestions">${chips(COMMON_OCCASIONS())}</div>
      <details class="more-occasions">
        <summary>More occasions</summary>
        ${OCCASION_GROUPS()
          .map((g) => `<div class="chip-group"><h3>${esc(g.title)}</h3><div class="chips">${chips(g.items)}</div></div>`)
          .join('')}
      </details>
      <label class="field">
        <span>Date <span class="muted">(optional)</span></span>
        <input type="date" name="event_date">
      </label>

      <fieldset class="field">
        <legend>How do you want to budget?</legend>
        <div class="segmented">
          <label><input type="radio" name="budget_mode" value="total" checked><span>
            <b>One budget for the event</b><small>A single amount covering everyone</small></span></label>
          <label><input type="radio" name="budget_mode" value="per_recipient"><span>
            <b>A budget per person</b><small>Set an amount for each recipient</small></span></label>
        </div>
      </fieldset>

      <label class="field" data-show="total">
        <span>Total budget</span>
        <div class="money-input"><span>${esc(currencySymbol())}</span><input name="total_budget" inputmode="decimal" placeholder="200"></div>
      </label>

      <fieldset class="field">
        <legend>Who are you buying for? <span class="muted" data-show="total">(optional)</span></legend>
        <p class="muted small" style="margin:-.2rem 0 .5rem">A first name or nickname is enough.</p>
        <div id="recipient-rows"></div>
        <button type="button" class="btn ghost sm" id="add-person">+ Add person</button>
      </fieldset>

      <div class="form-actions">
        <a href="#/events" class="btn ghost">Cancel</a>
        <button class="btn primary" type="submit">Create event</button>
      </div>
    </form>`;
}

function currencySymbol() {
  return moneyFmt.formatToParts(0).find((p) => p.type === 'currency')?.value ?? '$';
}

function mountNewEvent(root) {
  const form = root.querySelector('#new-event');
  const rows = form.querySelector('#recipient-rows');
  const mode = () => form.budget_mode.value;

  const addRow = (name = '') => {
    const row = document.createElement('div');
    row.className = 'recipient-row';
    row.innerHTML = `
      <input name="r_name" placeholder="Name" maxlength="80" aria-label="Recipient name" value="${esc(name)}">
      <div class="money-input" data-show="per_recipient"><span>${esc(currencySymbol())}</span>
        <input name="r_budget" inputmode="decimal" placeholder="Budget" aria-label="Budget for this person"></div>
      <button type="button" class="icon-btn" aria-label="Remove person">✕</button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    rows.append(row);
    sync();
    return row;
  };

  const sync = () => {
    form.querySelectorAll('[data-show]').forEach((el) => (el.hidden = el.dataset.show !== mode()));
    if (mode() === 'per_recipient' && !rows.children.length) addRow();
  };

  form.querySelectorAll('[name=budget_mode]').forEach((r) => r.addEventListener('change', sync));
  form.querySelector('#add-person').addEventListener('click', () => addRow().querySelector('input').focus());
  form.querySelectorAll('[data-idea]').forEach((b) =>
    b.addEventListener('click', () => {
      form.name.value = b.dataset.idea;
      form.name.focus();
    }),
  );
  sync();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) {
      form.name.focus();
      return toast('Give your event a name.', 'error');
    }
    const recipients = [...rows.children]
      .map((r) => ({
        name: r.querySelector('[name=r_name]').value.trim(),
        budget: mode() === 'per_recipient' ? parseMoney(r.querySelector('[name=r_budget]').value) : null,
      }))
      .filter((r) => r.name);
    if (mode() === 'per_recipient' && !recipients.length) return toast('Add at least one person to budget for.', 'error');

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const event = await store.createEvent(
        {
          name,
          event_date: form.event_date.value || null,
          budget_mode: mode(),
          total_budget: mode() === 'total' ? parseMoney(form.total_budget.value) : null,
        },
        recipients,
      );
      go(`/events/${event.id}`);
    } catch (err) {
      btn.disabled = false;
      fail(err);
    }
  });
}

// ---------------------------------------------------------------- event page

let current = null; // the event being viewed

async function eventPage(id) {
  current = await store.getEvent(id);
  if (!current) return notFoundPage();
  return renderEvent(current);
}

function renderEvent(e) {
  const s = B.summary(e);
  const listWarn = B.listWarning(e);
  const perPerson = e.budget_mode === 'per_recipient';

  let status = '';
  if (s.state === 'over') {
    status = `<div class="alert over" role="alert"><b>You're over budget by ${esc(money(s.spent - s.budget))}.</b>
      Consider returning something or raising the budget.</div>`;
  } else if (s.state === 'near') {
    status = `<div class="alert near" role="status"><b>Heads up: you've used ${Math.round((s.spent / s.budget) * 100)}% of your budget.</b>
      Only ${esc(money(s.left))} left.</div>`;
  } else if (listWarn) {
    status = `<div class="alert near" role="status">If you buy everything on your list at today's prices,
      you'll be <b>${esc(money(listWarn.over))} over budget</b>.</div>`;
  }

  const groups = e.recipients.map((r) => ({ r, gifts: e.gifts.filter((g) => g.recipient_id === r.id) }));
  const unassigned = e.gifts.filter((g) => !g.recipient_id || !e.recipients.some((r) => r.id === g.recipient_id));
  if (unassigned.length || !e.recipients.length) groups.push({ r: null, gifts: unassigned });

  return `
    <div class="crumbs"><a href="#/events">← My events</a></div>
    <div class="page-head event-head">
      <div>
        <h1>${esc(e.name)}</h1>
        ${e.event_date ? `<p class="muted">${esc(fmtDate(e.event_date))} · ${esc(countdown(e.event_date))}</p>` : ''}
      </div>
      <div class="head-actions">
        <button class="btn ghost sm" data-action="check-prices">Check prices now</button>
        <button class="btn ghost sm" data-action="edit-event">Edit</button>
        <button class="btn ghost sm danger-text" data-action="delete-event">Delete</button>
      </div>
    </div>

    <section class="budget-card card ${s.state}" aria-label="Budget">
      ${
        s.budget == null
          ? `<div class="budget-top"><div><div class="big">${esc(money(s.spent))}</div><div class="muted">spent so far · no budget set</div></div>
             <button class="btn primary sm" data-action="edit-event">Set a budget</button></div>`
          : `<div class="budget-top">
              <div><div class="big">${esc(money(s.spent))} <span class="of">of ${esc(money(s.budget))}</span></div>
                <div class="muted">${perPerson ? 'total of everyone’s budgets' : 'event budget'}</div></div>
              <div class="left ${s.left < 0 ? 'neg' : ''}"><div class="big">${esc(money(Math.abs(s.left)))}</div>
                <div class="muted">${s.left < 0 ? 'over budget' : 'left to spend'}</div></div>
            </div>`
      }
      ${progressBar(s)}
      <div class="legend">
        <span><i class="key spent"></i>Spent ${esc(money(s.spent))}</span>
        <span><i class="key planned"></i>Still on your list ${esc(money(s.planned))}</span>
        ${s.budget != null && s.spent + s.planned > s.budget ? `<span><i class="key limit"></i>Your budget</span>` : ''}
      </div>
      ${status}
    </section>

    <div class="list-head">
      <h2>Shopping list</h2>
      <div class="head-actions">
        <button class="btn ghost sm" data-action="add-recipient">+ Person</button>
        <button class="btn primary sm" data-action="add-gift">+ Add gift</button>
      </div>
    </div>

    ${groups.map((gr) => recipientGroup(e, gr.r, gr.gifts)).join('')}
    <p class="muted small center">${
      store.demo
        ? 'Prices are simulated for this demo. "Check prices now" moves the demo clock forward six hours.'
        : 'Prices are simulated for demonstration and don\u2019t come from real stores.'
    }</p>`;
}

function recipientGroup(e, r, gifts) {
  const rs = r ? B.recipientSummary(e, r) : null;
  const showBudget = r && e.budget_mode === 'per_recipient';
  return `
    <section class="group card">
      <header class="group-head">
        <div class="group-title">
          <h3>${r ? esc(r.name) : e.recipients.length ? 'Not assigned to anyone' : 'Gifts'}</h3>
          ${
            showBudget
              ? `<span class="muted small">${rs.budget == null ? `${esc(money(rs.spent))} spent · no budget` : `${esc(money(rs.spent))} of ${esc(money(rs.budget))}`}</span>`
              : r && rs.spent
                ? `<span class="muted small">${esc(money(rs.spent))} spent</span>`
                : ''
          }
          ${showBudget && rs.state === 'over' ? `<span class="pill over">Over by ${esc(money(rs.spent - rs.budget))}</span>` : ''}
          ${showBudget && rs.state === 'near' ? `<span class="pill near">Almost at budget</span>` : ''}
        </div>
        <div class="group-actions">
          ${r ? `<button class="btn ghost xs" data-action="edit-recipient" data-id="${esc(r.id)}">Edit</button>` : ''}
          <button class="btn ghost xs" data-action="add-gift" data-recipient="${r ? esc(r.id) : ''}">+ Gift</button>
        </div>
      </header>
      ${showBudget && rs.budget != null ? progressBar(rs, { size: 'sm' }) : ''}
      ${
        gifts.length
          ? `<ul class="gifts">${gifts.map(giftRow).join('')}</ul>`
          : `<p class="muted small empty-group">No gift ideas yet.</p>`
      }
    </section>`;
}

function giftRow(g) {
  const bought = g.status === 'bought';
  const sale = !bought && isOnSale(g.price_history ?? []);
  const atTarget = !bought && g.target_price != null && g.current_price != null && Number(g.current_price) <= Number(g.target_price);
  return `
    <li class="gift ${bought ? 'bought' : ''}">
      <div class="gift-main">
        <div class="gift-name">
          ${g.url ? `<a href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">${esc(g.name)}</a>` : esc(g.name)}
          ${sale ? `<span class="sale-tag">On sale</span>` : ''}
          ${atTarget ? `<span class="target-tag">At target</span>` : ''}
        </div>
        <div class="gift-sub muted small">
          ${
            bought
              ? `Bought for <b>${esc(money(g.amount_spent))}</b>${g.bought_at ? ` on ${esc(new Date(g.bought_at).toLocaleDateString())}` : ''}`
              : `${g.current_price != null ? `Now <b>${esc(money(g.current_price))}</b>` : 'No price yet'}
                 ${g.target_price != null ? ` · target ${esc(money(g.target_price))}` : ''}
                 ${g.track_price ? '' : ' · not tracking price'}`
          }
        </div>
      </div>
      ${bought ? '' : `<div class="gift-spark ${sale ? 'down' : ''}">${sparkline(g.price_history)}</div>`}
      <div class="gift-actions">
        ${
          bought
            ? `<button class="btn ghost xs" data-action="unbuy" data-id="${esc(g.id)}">Undo</button>`
            : `<button class="btn primary xs" data-action="buy" data-id="${esc(g.id)}">Mark bought</button>`
        }
        <button class="icon-btn" data-action="edit-gift" data-id="${esc(g.id)}" aria-label="Edit ${esc(g.name)}">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
        <button class="icon-btn" data-action="delete-gift" data-id="${esc(g.id)}" aria-label="Delete ${esc(g.name)}">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg></button>
      </div>
    </li>`;
}

async function reloadEvent() {
  const id = current.id;
  current = await store.getEvent(id);
  if (!current) return go('/events');
  app.innerHTML = renderEvent(current);
}

function warningHtml(warnings) {
  if (!warnings.length) return '';
  return warnings
    .map((w) =>
      w.state === 'over'
        ? `<div class="alert over" role="alert"><b>This will put you ${esc(money(w.over))} over ${esc(w.label)}</b>
            (${esc(money(w.after))} of ${esc(money(w.budget))}).</div>`
        : `<div class="alert near" role="status">This brings ${esc(w.label)} to ${esc(money(w.after))} of ${esc(money(w.budget))}.
            Only ${esc(money(w.budget - w.after))} left after this.</div>`,
    )
    .join('');
}

function buyModal(g) {
  const form = openModal(
    `
    <h2>Mark as bought</h2>
    <p class="muted">${esc(g.name)}</p>
    <label class="field">
      <span>Total amount spent</span>
      <div class="money-input"><span>${esc(currencySymbol())}</span>
        <input name="amount" inputmode="decimal" required value="${g.current_price != null ? Number(g.current_price).toFixed(2) : ''}" autofocus></div>
      <small class="muted">Include tax and shipping so your budget stays accurate.</small>
    </label>
    <div id="buy-warn" aria-live="polite"></div>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary" id="buy-submit">Mark bought</button>
    </div>`,
    (f) => {
      const update = () => {
        const amount = parseMoney(f.amount.value) ?? 0;
        const warnings = B.purchaseWarnings(current, g, amount);
        f.querySelector('#buy-warn').innerHTML = warningHtml(warnings);
        const over = warnings.some((w) => w.state === 'over');
        const btn = f.querySelector('#buy-submit');
        btn.textContent = over ? 'Mark bought anyway' : 'Mark bought';
        btn.className = `btn ${over ? 'danger' : 'primary'}`;
      };
      f.amount.addEventListener('input', update);
      update();
    },
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseMoney(form.amount.value);
    if (amount == null) return toast('Enter the amount you spent.', 'error');
    dialog.close();
    try {
      await store.updateGift(g.id, { status: 'bought', amount_spent: amount, bought_at: new Date().toISOString() });
      await reloadEvent();
      const s = B.summary(current);
      if (s.state === 'over') toast(`Recorded. You're now ${money(s.spent - s.budget)} over budget.`, 'error');
      else toast(`Recorded ${money(amount)}.`);
    } catch (err) {
      fail(err);
    }
  });
}

function giftModal(g, presetRecipient) {
  const editing = !!g;
  g = g ?? { name: '', url: '', recipient_id: presetRecipient || null, current_price: null, target_price: null, track_price: true };
  const form = openModal(
    `
    <h2>${editing ? 'Edit gift' : 'Add a gift'}</h2>
    <label class="field"><span>Gift</span>
      <input name="name" required maxlength="200" value="${esc(g.name)}" placeholder="e.g. Espresso machine" autofocus></label>
    <label class="field"><span>Link <span class="muted">(optional)</span></span>
      <input name="url" type="url" value="${esc(g.url ?? '')}" placeholder="https://…"></label>
    ${
      current.recipients.length
        ? `<label class="field"><span>For</span>
            <select name="recipient_id"><option value="">Not assigned</option>
              ${current.recipients.map((r) => `<option value="${esc(r.id)}" ${r.id === g.recipient_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
            </select></label>`
        : ''
    }
    <div class="field-row">
      <label class="field"><span>Current price</span>
        <div class="money-input"><span>${esc(currencySymbol())}</span>
          <input name="current_price" inputmode="decimal" value="${g.current_price ?? ''}" placeholder="0.00"></div></label>
      <label class="field"><span>Alert me at <span class="muted">(optional)</span></span>
        <div class="money-input"><span>${esc(currencySymbol())}</span>
          <input name="target_price" inputmode="decimal" value="${g.target_price ?? ''}" placeholder="Target"></div></label>
    </div>
    <label class="toggle"><input type="checkbox" name="track_price" ${g.track_price ? 'checked' : ''}>
      <span>Track price and alert me to sales</span></label>
    <div id="gift-warn" aria-live="polite"></div>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${editing ? 'Save' : 'Add to list'}</button>
    </div>`,
    (f) => {
      // Warn if this gift would push the whole list over budget.
      const update = () => {
        const price = parseMoney(f.current_price.value) ?? 0;
        const extra = price - (editing && g.status !== 'bought' ? Number(g.current_price ?? 0) : 0);
        const w = B.listWarning(current, extra);
        f.querySelector('#gift-warn').innerHTML = w
          ? `<div class="alert near">With this gift your list totals ${esc(money(w.total))}, which is
              ${esc(money(w.over))} over your ${esc(money(w.budget))} budget.</div>`
          : '';
      };
      f.current_price.addEventListener('input', update);
      update();
    },
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return toast('Name the gift.', 'error');
    let url = form.url.value.trim() || null;
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    const data = {
      name,
      url,
      recipient_id: form.recipient_id?.value || null,
      current_price: parseMoney(form.current_price.value),
      target_price: parseMoney(form.target_price.value),
      track_price: form.track_price.checked,
    };
    dialog.close();
    try {
      if (editing) await store.updateGift(g.id, data);
      else await store.addGift(current.id, data);
      await reloadEvent();
      await refreshNotifications();
    } catch (err) {
      fail(err);
    }
  });
}

function recipientModal(r) {
  const editing = !!r;
  const perPerson = current.budget_mode === 'per_recipient';
  const form = openModal(`
    <h2>${editing ? 'Edit person' : 'Add a person'}</h2>
    <label class="field"><span>Name <span class="muted">(a first name or nickname is enough)</span></span>
      <input name="name" required maxlength="80" value="${esc(r?.name ?? '')}" autofocus></label>
    ${
      perPerson
        ? `<label class="field"><span>Budget for this person</span>
            <div class="money-input"><span>${esc(currencySymbol())}</span>
              <input name="budget" inputmode="decimal" value="${r?.budget ?? ''}"></div></label>`
        : ''
    }
    <div class="modal-actions">
      ${editing ? `<button type="button" class="btn ghost danger-text" id="remove-recipient">Remove</button><span class="spacer"></span>` : ''}
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">${editing ? 'Save' : 'Add'}</button>
    </div>`);
  form.querySelector('#remove-recipient')?.addEventListener('click', async () => {
    dialog.close();
    const ok = await confirmModal({
      title: `Remove ${r.name}?`,
      body: 'Their gifts stay on the list, marked as not assigned to anyone.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.deleteRecipient(r.id);
      await reloadEvent();
    } catch (err) {
      fail(err);
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return toast('Enter a name.', 'error');
    const data = { name };
    if (perPerson) data.budget = parseMoney(form.budget.value);
    dialog.close();
    try {
      if (editing) await store.updateRecipient(r.id, data);
      else await store.addRecipient(current.id, data);
      await reloadEvent();
    } catch (err) {
      fail(err);
    }
  });
}

function editEventModal() {
  const e = current;
  const form = openModal(
    `
    <h2>Edit event</h2>
    <label class="field"><span>Name</span><input name="name" required maxlength="120" value="${esc(e.name)}" autofocus></label>
    <label class="field"><span>Date</span><input type="date" name="event_date" value="${esc(e.event_date ?? '')}"></label>
    <fieldset class="field"><legend>Budget</legend>
      <div class="segmented">
        <label><input type="radio" name="budget_mode" value="total" ${e.budget_mode === 'total' ? 'checked' : ''}><span><b>One budget</b><small>for the whole event</small></span></label>
        <label><input type="radio" name="budget_mode" value="per_recipient" ${e.budget_mode === 'per_recipient' ? 'checked' : ''}><span><b>Per person</b><small>set on each person</small></span></label>
      </div>
    </fieldset>
    <label class="field" id="total-field"><span>Total budget</span>
      <div class="money-input"><span>${esc(currencySymbol())}</span>
        <input name="total_budget" inputmode="decimal" value="${e.total_budget ?? ''}"></div></label>
    <p class="muted small" id="pp-note">Set each person's budget with the Edit button next to their name.</p>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary">Save</button>
    </div>`,
    (f) => {
      const sync = () => {
        const total = f.budget_mode.value === 'total';
        f.querySelector('#total-field').hidden = !total;
        f.querySelector('#pp-note').hidden = total;
      };
      f.querySelectorAll('[name=budget_mode]').forEach((r) => r.addEventListener('change', sync));
      sync();
    },
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = form.name.value.trim();
    if (!name) return toast('Give your event a name.', 'error');
    const mode = form.budget_mode.value;
    dialog.close();
    try {
      await store.updateEvent(e.id, {
        name,
        event_date: form.event_date.value || null,
        budget_mode: mode,
        total_budget: mode === 'total' ? parseMoney(form.total_budget.value) : e.total_budget,
      });
      await reloadEvent();
    } catch (err) {
      fail(err);
    }
  });
}

async function onEventAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !current || !app.contains(el)) return;
  const gift = el.dataset.id && current.gifts.find((g) => g.id === el.dataset.id);
  switch (el.dataset.action) {
    case 'add-gift':
      return giftModal(null, el.dataset.recipient);
    case 'edit-gift':
      return giftModal(gift);
    case 'buy':
      return buyModal(gift);
    case 'add-recipient':
      return recipientModal(null);
    case 'edit-recipient':
      return recipientModal(current.recipients.find((r) => r.id === el.dataset.id));
    case 'edit-event':
      return editEventModal();
    case 'unbuy':
      try {
        await store.updateGift(gift.id, { status: 'wanted', amount_spent: null, bought_at: null });
        await reloadEvent();
      } catch (err) {
        fail(err);
      }
      return;
    case 'delete-gift':
      if (!(await confirmModal({ title: 'Delete this gift?', body: esc(gift.name), confirm: 'Delete', danger: true }))) return;
      try {
        await store.deleteGift(gift.id);
        await reloadEvent();
      } catch (err) {
        fail(err);
      }
      return;
    case 'delete-event':
      if (
        !(await confirmModal({
          title: `Delete ${current.name}?`,
          body: 'This deletes the event, its shopping list and price history. It can’t be undone.',
          confirm: 'Delete event',
          danger: true,
        }))
      )
        return;
      try {
        await store.deleteEvent(current.id);
        current = null;
        go('/events');
      } catch (err) {
        fail(err);
      }
      return;
    case 'check-prices':
      el.disabled = true;
      el.textContent = 'Checking…';
      try {
        const res = await store.checkPrices({ event_id: current.id });
        await reloadEvent();
        await refreshNotifications();
        toast(
          res.checked
            ? `Checked ${res.checked} price${res.checked === 1 ? '' : 's'}${res.alerts ? ` · ${res.alerts} new alert${res.alerts === 1 ? '' : 's'}` : ''}.`
            : 'Nothing to check: prices are tracked only for gifts you haven’t bought yet.',
        );
      } catch (err) {
        el.disabled = false;
        el.textContent = 'Check prices now';
        fail(err);
      }
      return;
  }
}

app.addEventListener('click', onEventAction);

// ---------------------------------------------------------------- demo

function startDemo() {
  enterDemo();
  location.hash = '#/events';
  location.reload();
}

function leaveDemo() {
  exitDemo();
  location.hash = '#/';
  location.reload();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-start-demo]')) startDemo();
  else if (e.target.closest('[data-exit-demo]')) leaveDemo();
});

function notFoundPage() {
  return `<section class="empty"><h1>Not found</h1><p class="muted">That page or event doesn't exist.</p>
    <a href="#/" class="btn primary">Go home</a></section>`;
}

// ---------------------------------------------------------------- router

const routes = [
  [/^\/$/, homePage, null, false],
  [/^\/login$/, loginPage, mountLogin, false],
  [/^\/account$/, accountPage, mountAccount, true],
  [/^\/events$/, eventsPage, null, true],
  [/^\/events\/new$/, newEventPage, mountNewEvent, true],
  [/^\/events\/([0-9a-f-]{36})$/i, eventPage, null, true],
];

const TITLES = { '/login': 'Log in', '/account': 'My account', '/events': 'My events', '/events/new': 'New event' };

async function render() {
  const path = location.hash.slice(1) || '/';
  renderNav();
  const match = routes.map(([re, view, mount, auth]) => ({ m: path.match(re), view, mount, auth })).find((r) => r.m);

  if (match?.auth && !user) {
    try {
      sessionStorage.setItem('giftbudget-next', path);
    } catch {
      /* ignore */
    }
    return go('/login');
  }
  if (path === '/login' && user) return go('/events');

  if (dialog.open) dialog.close();
  current = null;
  app.setAttribute('aria-busy', 'true');
  try {
    const html = match ? await match.view(...match.m.slice(1)) : notFoundPage();
    if ((location.hash.slice(1) || '/') !== path) return; // navigated away meanwhile
    app.innerHTML = html;
    match?.mount?.(app);
  } catch (e) {
    fail(e);
    app.innerHTML = `<section class="empty"><h1>Couldn't load this page</h1><p class="muted">${esc(e.message)}</p></section>`;
  } finally {
    app.removeAttribute('aria-busy');
  }
  // Analytics page view (sent only if the visitor accepted cookies). The
  // title is generic so event names never leave the browser.
  window.giftAnalytics?.trackRoute(`/#${path}`, current ? 'Event' : TITLES[path] || 'Home');
  document.title = current ? `${current.name} · GiftingSmart` : TITLES[path] ? `${TITLES[path]} · GiftingSmart` : 'GiftingSmart: gift planner and budget tracker for every occasion';
  window.scrollTo(0, 0);
  app.focus({ preventScroll: true });
  document.documentElement.classList.add('app-ready');
}

async function init() {
  store = await createStore(window.GIFT_CONFIG ?? {});
  user = await store.getUser();

  store.onAuthChange(async (u) => {
    const was = user?.id;
    user = u;
    if (was === u?.id) return;
    notifications = [];
    if (u) {
      let next = '/events';
      try {
        next = sessionStorage.getItem('giftbudget-next') || next;
        sessionStorage.removeItem('giftbudget-next');
      } catch {
        /* ignore */
      }
      await refreshNotifications();
      go(next);
    } else {
      render();
    }
  });

  window.addEventListener('hashchange', render);
  const banner = document.getElementById('demo-banner');
  if (store.visitorDemo) {
    banner.innerHTML = `You're exploring the demo with sample data, saved only in this browser.
      <button type="button" class="link-btn" data-exit-demo>Exit demo</button>`;
    if (!user) {
      await store.startDemo();
      user = await store.getUser();
    }
  }
  banner.hidden = !store.demo;
  await render();
  refreshNotifications();
  // Pick up new sale alerts while the app is open.
  setInterval(refreshNotifications, 5 * 60 * 1000);
  window.addEventListener('focus', refreshNotifications);
}

init().catch((e) => {
  console.error(e);
  app.innerHTML = `<section class="empty"><h1>GiftingSmart couldn't start</h1><p class="muted">${esc(e.message)}</p></section>`;
});
