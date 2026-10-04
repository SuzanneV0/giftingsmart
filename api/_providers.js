// Price providers. Each one looks up the current price of a gift.
//
// To add a real provider (Keepa, SerpApi, Rainforest, ...):
//   1. add an object below with a name and an async getPrice(gift) returning { price, source } or null
//   2. set PRICE_PROVIDER=<name> (and its API key) in Vercel's settings
import { mockPrice } from '../shared/pricing.js';

// Simulated prices so the whole pipeline (history, sale alerts, sparklines) works before a real
// price API is connected.
const mock = {
  name: 'mock',
  async getPrice(gift) {
    const base = Number(gift.base_price ?? gift.current_price ?? 0);
    return { price: mockPrice(gift.id, base), source: 'mock' };
  },
};

const PROVIDERS = { mock };

export function getProvider() {
  const name = process.env.PRICE_PROVIDER || 'mock';
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown PRICE_PROVIDER "${name}"`);
  return provider;
}
