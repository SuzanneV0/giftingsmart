// The main flows, end to end in a real browser: create an event, add a gift, mark it bought,
// and the over-budget warnings. Each test gets a fresh browser, so it starts signed out.
import { test, expect } from '@playwright/test';

/** Signs in as the demo user (what "Continue with Google" does when sign-in isn't connected). */
async function signIn(page) {
  await page.goto('/#/login');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('button', { name: /^Price alerts/ })).toBeVisible();
}

async function createEvent(page, name, budget) {
  await page.goto('/#/events/new');
  await page.getByLabel('Event name').fill(name);
  await page.getByLabel('Total budget').fill(String(budget));
  await page.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

/** Adds a gift with a fixed price (price tracking off, so the simulated price doesn't move). */
async function addGift(page, name, price) {
  await page.getByRole('button', { name: '+ Add gift' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Gift').fill(name);
  await dialog.getByLabel('Current price').fill(String(price));
  await dialog.getByLabel('Track price and alert me to sales').uncheck();
  return dialog;
}

const budgetCard = (page) => page.getByRole('region', { name: 'Budget' });

test('create an event and see its budget', async ({ page }) => {
  await signIn(page);
  await createEvent(page, "Lauren's birthday", 100);
  await expect(budgetCard(page)).toContainText('$0.00 of $100.00');
  await expect(budgetCard(page)).toContainText(/\$100\.00\s*left to spend/);

  await page.getByRole('link', { name: '← My events' }).click();
  await expect(page.getByRole('link', { name: /Lauren's birthday/ })).toContainText('$0.00 of $100.00');
});

test('add a gift, mark it bought, and undo', async ({ page }) => {
  await signIn(page);
  await createEvent(page, 'Housewarming', 100);

  const dialog = await addGift(page, 'Board game', 40);
  await dialog.getByRole('button', { name: 'Add to list' }).click();
  const gift = page.locator('li.gift', { hasText: 'Board game' });
  await expect(gift).toContainText('Now $40.00');
  await expect(budgetCard(page)).toContainText('Still on your list $40.00');

  await gift.getByRole('button', { name: 'Mark bought' }).click();
  const buy = page.getByRole('dialog');
  await expect(buy.getByLabel('Total amount spent')).toHaveValue('40.00');
  await buy.getByLabel('Total amount spent').fill('35');
  await buy.getByRole('button', { name: 'Mark bought' }).click();

  await expect(gift).toContainText('Bought for $35.00');
  await expect(budgetCard(page)).toContainText('$35.00 of $100.00');
  await expect(budgetCard(page)).toContainText(/\$65\.00\s*left to spend/);

  await gift.getByRole('button', { name: 'Undo' }).click();
  await expect(gift).toContainText('Now $40.00');
  await expect(budgetCard(page)).toContainText('$0.00 of $100.00');
});

test('warns before a gift or purchase goes over budget', async ({ page }) => {
  await signIn(page);
  await createEvent(page, 'Secret Santa', 100);

  // The list itself would go over budget.
  const dialog = await addGift(page, 'Espresso machine', 150);
  await expect(dialog).toContainText('which is $50.00 over your $100.00 budget');
  await dialog.getByRole('button', { name: 'Add to list' }).click();
  await expect(budgetCard(page)).toContainText("you'll be $50.00 over budget");

  // Recording the purchase warns first, then the event shows it's over.
  await page.locator('li.gift', { hasText: 'Espresso machine' }).getByRole('button', { name: 'Mark bought' }).click();
  const buy = page.getByRole('dialog');
  await expect(buy.getByRole('alert')).toContainText('This will put you $50.00 over');
  await buy.getByRole('button', { name: 'Mark bought anyway' }).click();

  await expect(budgetCard(page).getByRole('alert')).toContainText("You're over budget by $50.00.");
  await page.getByRole('link', { name: '← My events' }).click();
  await expect(page.getByRole('link', { name: /Secret Santa/ })).toContainText('Over budget');
});

test('the demo explains that prices are simulated and has no email alerts', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/events');
  await page.getByRole('link', { name: /Holiday gifts/ }).click();
  await expect(page.getByText('Prices are simulated for this demo.')).toBeVisible();

  await page.goto('/#/account');
  await expect(page.getByLabel('Email me when a gift goes on sale or hits my target price')).toBeDisabled();
  await expect(page.getByText('Email alerts aren’t available in the demo.')).toBeVisible();
});
