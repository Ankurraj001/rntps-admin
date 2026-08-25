import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * One sign-in for the whole file, reused across tests.
 *
 * Signing in per test would exceed the API's real /auth/login rate limit (10 per minute
 * per IP) — a production safeguard worth keeping rather than loosening for tests. Serial
 * mode keeps the shared page predictable.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await page.close();
});

test.describe('navigation', () => {
  test('every admin page loads without an error boundary', async () => {
    const pages = [
      { path: '/students', heading: 'Students' },
      { path: '/attendance', heading: 'Mark attendance' },
      { path: '/attendance/monthly', heading: 'Monthly attendance' },
      { path: '/fees/structures', heading: 'Fee structure' },
      { path: '/fees/run', heading: 'Generate invoices' },
      { path: '/fees/invoices', heading: 'Invoices' },
      { path: '/notifications', heading: 'Fee reminders' },
      { path: '/reports', heading: 'Reports' },
      { path: '/users', heading: 'Users' },
      { path: '/settings', heading: 'Settings' },
    ];

    for (const { path, heading } of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
    }
  });

  test('an unknown route shows the not-found page rather than a blank screen', async () => {
    await page.goto('/does-not-exist');
    await expect(page.getByText('Page not found')).toBeVisible();
  });
});

test.describe('attendance', () => {
  test('the roster defaults everyone to present and saves', async () => {
    await page.goto('/attendance');

    // The default class may be empty, so walk the options until one has students.
    // This keeps the test meaningful whatever the dataset looks like.
    const classSelect = page.getByLabel('Class');
    // goto() resolves on document load, which is before React has mounted the select.
    // Reading the options without this returned an empty list, so the loop below never
    // ran and the test silently skipped itself.
    await classSelect.waitFor({ state: 'visible' });

    const options = await classSelect.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value),
    );
    expect(options.length, 'class options should be rendered').toBeGreaterThan(0);

    const rows = page.locator('tbody tr');
    for (const value of options) {
      await classSelect.selectOption(value);
      // Waits on the DOM, not on the network: the roster response arriving is not the
      // same as React having rendered the rows, and checking count() too early made this
      // silently skip.
      const hasStudents = await rows
        .first()
        .waitFor({ state: 'visible', timeout: 1500 })
        .then(() => true)
        .catch(() => false);
      if (hasStudents) break;
    }

    const count = await rows.count();
    test.skip(count === 0, 'No class has any active students');

    // Present is pre-selected, which is the whole point of the marking flow.
    await expect(rows.first().getByRole('button', { name: /Present/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: 'Save attendance' }).click();
    await expect(page.getByRole('button', { name: /Saved/ })).toBeVisible();
  });
});

test.describe('fees', () => {
  test('the invoice run previews before it commits', async () => {
    await page.goto('/fees/run');
    await page.getByRole('button', { name: 'Preview' }).click();

    // Either a preview table or a clear explanation of why there is nothing to bill.
    // .first() because "no fee structure" legitimately appears in several places.
    await expect(
      page.getByText(/Step 2 — review and commit|No fee structure|Nothing to bill/).first(),
    ).toBeVisible();
  });

  test('reports export a CSV through an authenticated download', async () => {
    await page.goto('/reports');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const file = await download;

    // A plain <a href> would have 401'd here, since the token is in memory.
    expect(file.suggestedFilename()).toMatch(/^dues-.*\.csv$/);
  });
});

test.describe('admin navigation', () => {
  test('admin-only sections are present for an admin', async () => {
    await page.goto('/');
    for (const label of ['Users', 'Reports', 'Settings', 'Invoices', 'Fee structure']) {
      await expect(page.getByRole('link', { name: label })).toBeVisible();
    }
  });

  test('the dashboard header comes from the dashboard payload, not GET /settings', async () => {
    // GET /settings is admin-only, so a teacher's header must not depend on it. Asserting
    // the admin case here at least proves the new field is wired through.
    await page.goto('/');
    const settingsCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/settings')) settingsCalls.push(r.url());
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: /Good day/ })).toBeVisible();
    expect(settingsCalls).toEqual([]);
  });
});
