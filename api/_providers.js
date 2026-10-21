// Price providers. Each one looks up the current price of a gift.
//
// To add another provider (Keepa, Rainforest, ...):
//   1. add an object below with a name and an async getPrice(gift) returning { price, source } or null
//   2. set PRICE_PROVIDER=<name> (and its API key) in Vercel's settings
//
// A provider only ever receives the gift's name and store link, never anything about the user or
// the person the gift is for.
import { mockPrice, round2 } from '../shared/pricing.js';

// Simulated prices so the whole pipeline (history, sale alerts, sparklines) works before a real
// price API is connected.
const mock = {
  name: 'mock',
  maxPerRun: 500,
  async getPrice(gift) {
    const base = Number(gift.base_price ?? gift.current_price ?? 0);
    return { price: mockPrice(gift.id, base), source: 'mock' };
  },
};

/** The site name of a link without "www.", e.g. "bestbuy.ca", or null. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Picks the price to record from SerpApi's Google Shopping results. When the gift has a store link,
 * the offer from that store wins, so the price history follows one seller; otherwise the top result.
 */
export function pickShoppingResult(results, url) {
  const offers = (Array.isArray(results) ? results : []).filter(
    (r) => typeof r?.extracted_price === 'number' && r.extracted_price > 0,
  );
  if (!offers.length) return null;
  const host = url ? hostOf(url) : null;
  if (host) {
    const site = host.split('.').slice(-2, -1)[0]; // "bestbuy" from "bestbuy.ca"
    const match = offers.find((r) => {
      const link = hostOf(r.link || r.product_link || '');
      if (link && (link === host || link.endsWith(`.${host}`))) return true;
      return site?.length >= 3 && String(r.source || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(site);
    });
    if (match) return match;
  }
  return offers[0];
}

// Google Shopping prices through SerpApi (https://serpapi.com/google-shopping-api). Each lookup is
// one search on the SerpApi plan, so a run checks at most maxPerRun gifts (the least recently
// checked first), identical lookups in one run are shared, and a gift checked in the last hour is
// skipped when someone clicks "Check prices now".
//   SERPAPI_KEY      the API key (required)
//   SERPAPI_COUNTRY  Google country code for prices, default "ca" (Canadian stores, in CAD)
//   SERPAPI_MAX_PER_RUN  gifts checked per run, default 100
//   SERPAPI_DAILY_LIMIT  hard cap on lookups per UTC day across all runs and users, default 300
const serpapi = {
  name: 'serpapi',
  maxPerRun: Number(process.env.SERPAPI_MAX_PER_RUN) || 100,
  dailyLimit: Number(process.env.SERPAPI_DAILY_LIMIT) || 300,
  minRecheckMs: 60 * 60 * 1000,
  cache: new Map(),
  async getPrice(gift) {
    const key = process.env.SERPAPI_KEY;
    if (!key) throw new Error('SERPAPI_KEY is not set');
    const query = String(gift.name || '').trim().slice(0, 200);
    if (!query) return null;
    const country = (process.env.SERPAPI_COUNTRY || 'ca').toLowerCase();
    const cacheKey = `${country}|${query.toLowerCase()}|${hostOf(gift.url) ?? ''}`;
    if (!this.cache.has(cacheKey)) {
      const lookup = (async () => {
        const params = new URLSearchParams({ engine: 'google_shopping', q: query, gl: country, hl: 'en', api_key: key });
        const res = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`SerpApi responded ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(`SerpApi: ${data.error}`);
        const best = pickShoppingResult(data.shopping_results, gift.url);
        return best ? { price: round2(best.extracted_price), source: 'serpapi' } : null;
      })();
      this.cache.set(cacheKey, lookup);
      // Failed lookups aren't kept, so the next run tries again.
      lookup.catch(() => this.cache.delete(cacheKey));
    }
    return this.cache.get(cacheKey);
  },
  /** Called at the start of each run: a warm function instance must not reuse last run's prices. */
  reset() {
    this.cache.clear();
  },
};

const PROVIDERS = { mock, serpapi };

export function getProvider() {
  const name = process.env.PRICE_PROVIDER || 'mock';
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown PRICE_PROVIDER "${name}"`);
  provider.reset?.();
  return provider;
}
