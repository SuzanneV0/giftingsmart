// Tests for the price providers (api/_providers.js) and alert emails (api/_email.js), run with: npm test
// No real API is called: fetch is replaced with a stub.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, hostOf, pickShoppingResult } from '../api/_providers.js';
import { alertEmail } from '../api/_email.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PRICE_PROVIDER;
  delete process.env.SERPAPI_KEY;
});

const RESULTS = [
  { title: 'Espresso machine', source: 'Amazon.ca', link: 'https://www.amazon.ca/dp/X', extracted_price: 129.99 },
  { title: 'Espresso machine', source: 'Best Buy', product_link: 'https://www.google.com/shopping/product/1', extracted_price: 119 },
  { title: 'Espresso machine', source: 'Canadian Tire', link: 'https://www.canadiantire.ca/p/1', extracted_price: 124.5 },
];

test('hostOf strips www. and rejects non-links', () => {
  assert.equal(hostOf('https://www.BestBuy.ca/en-ca/product/1'), 'bestbuy.ca');
  assert.equal(hostOf('not a link'), null);
});

test('pickShoppingResult follows the store in the gift link, else the top result', () => {
  assert.equal(pickShoppingResult(RESULTS, 'https://www.canadiantire.ca/p/1').extracted_price, 124.5, 'by link');
  assert.equal(pickShoppingResult(RESULTS, 'https://www.bestbuy.ca/en-ca/product/1').extracted_price, 119, 'by store name');
  assert.equal(pickShoppingResult(RESULTS, 'https://www.walmart.ca/x').extracted_price, 129.99, 'no match: top result');
  assert.equal(pickShoppingResult(RESULTS, null).extracted_price, 129.99);
  assert.equal(pickShoppingResult([{ source: 'X', extracted_price: null }], null), null, 'results without a price are skipped');
  assert.equal(pickShoppingResult(undefined, null), null);
});

test('mock is the default provider', () => {
  assert.equal(getProvider().name, 'mock');
  process.env.PRICE_PROVIDER = 'nope';
  assert.throws(() => getProvider(), /Unknown PRICE_PROVIDER/);
});

test('serpapi sends only the gift name, in Canada by default, and shares identical lookups', async () => {
  process.env.PRICE_PROVIDER = 'serpapi';
  process.env.SERPAPI_KEY = 'test-key';
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url));
    return new Response(JSON.stringify({ shopping_results: RESULTS }), { status: 200 });
  };
  const provider = getProvider();
  const gift = { id: 'g1', name: 'Espresso machine', url: 'https://www.canadiantire.ca/p/1', user_id: 'user_alice' };
  assert.deepEqual(await provider.getPrice(gift), { price: 124.5, source: 'serpapi' });
  assert.deepEqual(await provider.getPrice({ ...gift, id: 'g2' }), { price: 124.5, source: 'serpapi' });
  assert.equal(calls.length, 1, 'the same search in one run is made once');
  const params = Object.fromEntries(calls[0].searchParams);
  assert.equal(calls[0].hostname, 'serpapi.com');
  assert.deepEqual(
    { engine: params.engine, q: params.q, gl: params.gl },
    { engine: 'google_shopping', q: 'Espresso machine', gl: 'ca' },
  );
  assert.ok(!calls[0].href.includes('user_alice'), 'nothing about the user is sent');

  getProvider(); // a new run starts with an empty cache
  await provider.getPrice(gift);
  assert.equal(calls.length, 2);
});

test('serpapi reports errors and returns null when nothing has a price', async () => {
  process.env.PRICE_PROVIDER = 'serpapi';
  const provider = getProvider();
  await assert.rejects(provider.getPrice({ name: 'Mug' }), /SERPAPI_KEY is not set/);
  process.env.SERPAPI_KEY = 'test-key';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Invalid API key.' }), { status: 200 });
  await assert.rejects(provider.getPrice({ name: 'Mug' }), /Invalid API key/);
  globalThis.fetch = async () => new Response(JSON.stringify({ shopping_results: [] }), { status: 200 });
  assert.equal(await provider.getPrice({ name: 'Mug' }), null, 'a failed lookup is retried, not cached');
});

test('alert email lists each alert with a link, and escapes gift names', () => {
  const one = alertEmail([{ kind: 'target', message: 'Scarf hit your target price: $70.00 (was $89.00).', event_id: 'e1' }]);
  assert.equal(one.subject, 'A gift hit your target price');
  assert.match(one.text, /https:\/\/giftingsmart\.shop\/#\/events\/e1/);
  assert.match(one.text, /turn off email alerts/);

  const two = alertEmail([
    { kind: 'sale', message: '<b>Mug</b> is on sale', event_id: 'e1' },
    { kind: 'sale', message: 'Socks are on sale', event_id: 'e2' },
  ]);
  assert.equal(two.subject, '2 gifts on your list dropped in price');
  assert.ok(two.html.includes('&lt;b&gt;Mug&lt;/b&gt;') && !two.html.includes('<b>Mug'), 'gift names are escaped');
});
