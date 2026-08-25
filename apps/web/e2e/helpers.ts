import type { Page } from '@playwright/test';

/**
 * Credentials are required from the environment rather than defaulted.
 *
 * A hard-coded admin would mean shipping a live account — with a known password — in
 * whatever database the suite is pointed at, which for this project is a real school's
 * cluster. Failing loudly with instructions is better than a confusing 401.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      [
        `${name} is not set.`,
        '',
        'End-to-end tests need an admin account in whatever database the app is pointed at:',
        '',
        '  npm run seed:admin -- "E2E Bot" e2e@rntps.local     # prints a temporary password',
        '  # sign in once to set a real password, then:',
        '  E2E_ADMIN_EMAIL=e2e@rntps.local E2E_ADMIN_PASSWORD=... npm run test:e2e',
        '',
        'Prefer a staging database. Deactivate the account when you are done.',
      ].join('\n'),
    );
  }
  return value;
}

export const ADMIN = {
  get email(): string {
    return required('E2E_ADMIN_EMAIL');
  },
  get password(): string {
    return required('E2E_ADMIN_PASSWORD');
  },
};

export async function signIn(page: Page, email = ADMIN.email, password = ADMIN.password): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
}
