import { expect, test } from '@playwright/test';
import { signIn, signOut } from './helpers';

// These deliberately exercise sign-in and sign-out, so each needs its own session.
// Kept to four tests to stay inside the login rate limit.
test.describe('authentication', () => {
  test('an anonymous visitor is sent to the login page', async ({ page }) => {
    await page.goto('/students');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'RNTPS Admin' })).toBeVisible();
  });

  test('bad credentials are rejected', async ({ page }) => {
    // Deliberately an address that does not exist. Aiming this at the real E2E account
    // would spend one of its five allowed failures and eventually lock it out — the same
    // account every other test signs in with. The API suite already covers the
    // wrong-password and lockout paths directly.
    await page.goto('/login');
    await page.getByLabel('Email').fill('definitely-not-a-user@rntps.invalid');
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toContainText(/incorrect/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test('signing in reaches the dashboard, and the session survives a reload', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: /Good day/ })).toBeVisible();

    // The access token lives in memory only; surviving a reload proves the httpOnly
    // refresh cookie round-trip works.
    await page.reload();
    await expect(page.getByRole('heading', { name: /Good day/ })).toBeVisible();
  });

  test('signing out ends the session for good', async ({ page }) => {
    await signIn(page);
    await signOut(page);

    await page.goto('/students');
    await expect(page).toHaveURL(/\/login/);
  });
});
