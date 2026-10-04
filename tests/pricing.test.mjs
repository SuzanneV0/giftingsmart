// Unit tests for the shared price logic (shared/pricing.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAlert, isOnSale, mockPrice, round2 } from '../shared/pricing.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1, 12);
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const history = (...prices) => prices.map((price, i) => ({ price, checked_at: at(prices.length - i) }));
const gift = { name: 'Espresso machine', target_price: null };

test('round2 rounds to cents', () => {
  assert.equal(round2(19.994), 19.99);
  assert.equal(round2(19.996), 20);
  assert.equal(round2(42), 42);
});

test('mockPrice is deterministic for the same gift and time', () => {
  assert.equal(mockPrice('gift-1', 100, NOW), mockPrice('gift-1', 100, NOW));
});

test('mockPrice stays within a realistic band around the base price', () => {
  for (let i = 0; i < 400; i++) {
    const p = mockPrice('gift-2', 100, NOW + i * 6 * 60 * 60 * 1000);
    assert.ok(p >= 100 * (1 - 0.3 - 0.04) - 0.01 && p <= 100 * 1.04 + 0.01, `price ${p} out of range`);
  }
});

test('mockPrice invents a sensible base price when none is known', () => {
  const p = mockPrice('no-price-gift', 0, NOW);
  assert.ok(p > 0 && p < 210);
});

test('no alert on the first price observation', () => {
  assert.equal(detectAlert(gift, [], 50, NOW), null);
});

test('sale alert: at least 5% below the last price and the lowest in 30 days', () => {
  const alert = detectAlert(gift, history(100, 98, 100), 90, NOW);
  assert.equal(alert.kind, 'sale');
  assert.match(alert.message, /Espresso machine is on sale: \$90\.00, 10% off \(was \$100\.00\)/);
});

test('no sale alert for a small dip under 5%', () => {
  assert.equal(detectAlert(gift, history(100, 100), 96, NOW), null);
});

test('no sale alert if the price was lower within the last 30 days', () => {
  // Dropped 10% from yesterday, but it was $85 two weeks ago.
  const h = [
    { price: 85, checked_at: at(14) },
    { price: 100, checked_at: at(1) },
  ];
  assert.equal(detectAlert(gift, h, 90, NOW), null);
});

test('a low price from more than 30 days ago does not block a new sale alert', () => {
  const h = [
    { price: 70, checked_at: at(45) },
    { price: 100, checked_at: at(1) },
  ];
  assert.equal(detectAlert(gift, h, 90, NOW).kind, 'sale');
});

test('target alert fires when the price crosses the target, and takes priority', () => {
  const g = { name: 'Headphones', target_price: 80 };
  const alert = detectAlert(g, history(100), 79, NOW);
  assert.equal(alert.kind, 'target');
  assert.match(alert.message, /hit your target price: \$79\.00/);
});

test('no repeat target alert when the price was already at or below target', () => {
  const g = { name: 'Headphones', target_price: 80 };
  assert.equal(detectAlert(g, history(78), 77.5, NOW), null);
});

test('history order does not matter', () => {
  const shuffled = [
    { price: 100, checked_at: at(1) },
    { price: 100, checked_at: at(3) },
    { price: 98, checked_at: at(2) },
  ];
  assert.equal(detectAlert(gift, shuffled, 90, NOW).kind, 'sale');
});

test('isOnSale compares the latest price with the average of earlier ones', () => {
  assert.equal(isOnSale(history(100)), false);
  assert.equal(isOnSale(history(100, 100, 94)), true);
  assert.equal(isOnSale(history(100, 100, 97)), false);
});
