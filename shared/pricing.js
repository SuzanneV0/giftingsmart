// Price logic shared by the check-prices API function (api/check-prices.js) and the
// in-browser demo mode. Plain ES module, no dependencies.

const SIX_HOURS = 6 * 60 * 60 * 1000;

// A price drop only counts as a "sale" if it is at least this much below the
// previous observation AND is the lowest price seen in the lookback window.
export const SALE_MIN_DROP = 0.05;
export const SALE_LOOKBACK_DAYS = 30;

export function round2(n) {
  return Math.round(n * 100) / 100;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic 0..1 from a seed string.
function rand(seed) {
  let t = hash(seed) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Mock price for a gift at a point in time. Wanders a few percent around
 * `base`, and roughly one day in five the item is "on sale" for 10–30% off.
 * Same inputs always give the same price, so reruns are stable.
 */
export function mockPrice(key, base, now = Date.now()) {
  const seedBase = base > 0 ? base : 15 + rand(key + ':base') * 185;
  const slot = Math.floor(now / SIX_HOURS);
  const day = Math.floor(slot / 4);
  const noise = (rand(`${key}:${slot}`) - 0.5) * 0.08;
  const onSale = rand(`${key}:sale:${day}`) < 0.2;
  const discount = onSale ? 0.1 + rand(`${key}:disc:${day}`) * 0.2 : 0;
  return round2(Math.max(0.5, seedBase * (1 + noise - discount)));
}

/**
 * Decide whether a new price observation deserves an alert.
 * @param gift     { name, target_price }
 * @param history  earlier observations [{ price, checked_at }], any order
 * @param price    the new price
 * @returns        { kind: 'sale' | 'target', message } or null
 */
export function detectAlert(gift, history, price, now = Date.now(), format = defaultFormat) {
  if (!history.length) return null;
  const sorted = [...history].sort((a, b) => new Date(a.checked_at) - new Date(b.checked_at));
  const prev = Number(sorted[sorted.length - 1].price);
  const target = gift.target_price == null ? null : Number(gift.target_price);

  if (target != null && price <= target && prev > target) {
    return {
      kind: 'target',
      message: `${gift.name} hit your target price: ${format(price)} (was ${format(prev)}).`,
    };
  }

  const since = now - SALE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const recent = sorted.filter((h) => new Date(h.checked_at).getTime() >= since).map((h) => Number(h.price));
  const recentLow = recent.length ? Math.min(...recent) : prev;
  if (price <= prev * (1 - SALE_MIN_DROP) && price < recentLow) {
    const pct = Math.round((1 - price / prev) * 100);
    return {
      kind: 'sale',
      message: `${gift.name} is on sale: ${format(price)}, ${pct}% off (was ${format(prev)}).`,
    };
  }
  return null;
}

/** True if the latest price is a sale relative to the rest of the history. */
export function isOnSale(history) {
  if (history.length < 2) return false;
  const sorted = [...history].sort((a, b) => new Date(a.checked_at) - new Date(b.checked_at));
  const latest = Number(sorted[sorted.length - 1].price);
  const earlier = sorted.slice(0, -1).map((h) => Number(h.price));
  const typical = earlier.reduce((s, p) => s + p, 0) / earlier.length;
  return latest <= typical * (1 - SALE_MIN_DROP);
}

function defaultFormat(n) {
  return `$${Number(n).toFixed(2)}`;
}
