import { expect, test } from '@playwright/test';

// Selector updates for the founder-pilot package naming (unified V7 copy):
// CTA "Create your Get Your Moderator account"; labels "Your name" / "Email" / "Mobile number";
// guidance "Consent is required to create your account.". Every behavior assertion
// (consent gating, zero requests until consent, single-submit, aria wiring,
// narrow-viewport usability) is preserved verbatim.

test('unchecked terms keep signup disabled without a request or browser error', async ({ page }) => {
  const signupRequests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!requestUrl.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (route.request().method() === 'POST' && /auth\/signup/.test(requestUrl.pathname)) {
      signupRequests.push(route.request().url());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            user: { id: 'playwright-user', email: 'consent-browser@example.com' },
            shop: { id: 'playwright-shop', name: 'Playwright Shop' },
          },
        }),
      });
      return;
    }
    const body = requestUrl.pathname === '/api/auth/me'
      ? { success: true, data: null }
      : requestUrl.pathname === '/api/csrf'
        ? { csrfToken: 'playwright-test-token' }
        : { success: true, data: {} };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/signup');

  const submit = page.getByRole('button', { name: /create your get your moderator account/i });
  const terms = page.getByRole('checkbox', { name: /privacy policy/i });
  await expect(submit).toBeDisabled();
  await expect(terms).not.toBeChecked();
  await expect(page.getByText(/consent is required to create your account/i)).toBeVisible();

  await page.getByLabel('Your name').fill('Consent Browser User');
  await page.getByLabel('Email').fill('consent-browser@example.com');
  await page.getByLabel('Mobile number').fill('01712345678');
  await page.getByLabel('Password').fill('ValidPass123!');
  await expect(submit).toBeDisabled();

  await page.locator('form').evaluate((form) => {
    if (!(form instanceof HTMLFormElement)) throw new Error('Signup form was not found');
    form.requestSubmit();
  });
  await expect(submit).toBeDisabled();
  await expect(page.getByText(/creating account/i)).toHaveCount(0);
  await expect(terms).toHaveAttribute('aria-describedby', /terms-guidance/);

  expect(signupRequests).toHaveLength(0);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  await expect(page.getByRole('link', { name: /privacy policy/i }).first()).toHaveAttribute('href', /privacy-policy/);
  await expect(page.getByRole('link', { name: /terms of service/i }).first()).toHaveAttribute('href', /terms/);

  await terms.focus();
  await page.keyboard.press('Space');
  await expect(terms).toBeChecked();
  await expect(submit).toBeEnabled();
  await page.keyboard.press('Space');
  await expect(terms).not.toBeChecked();
  await expect(submit).toBeDisabled();
  expect(signupRequests).toHaveLength(0);
});

test('signup consent control remains usable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route('**/*', (route) => {
    const requestUrl = new URL(route.request().url());
    if (!requestUrl.pathname.startsWith('/api/')) return route.continue();
    const body = requestUrl.pathname === '/api/auth/me'
      ? { success: true, data: null }
      : requestUrl.pathname === '/api/csrf'
        ? { csrfToken: 'playwright-test-token' }
        : { success: true, data: {} };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.goto('/signup');

  await expect(page.getByRole('checkbox', { name: /privacy policy/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /privacy policy/i }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /terms of service/i }).first()).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow-x', 'visible');
});

test('accepted signup sends one consented request under rapid submission', async ({ page }) => {
  const signupRequests: { body: string | null }[] = [];

  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!requestUrl.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (route.request().method() === 'POST' && requestUrl.pathname === '/api/auth/signup') {
      signupRequests.push({ body: route.request().postData() });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            user: { id: 'playwright-user', email: 'rapid-consent@example.com' },
            shop: { id: 'playwright-shop', name: 'Playwright Shop' },
          },
        }),
      });
      return;
    }
    const body = requestUrl.pathname === '/api/auth/me'
      ? { success: true, data: null }
      : requestUrl.pathname === '/api/csrf'
        ? { csrfToken: 'playwright-test-token' }
        : { success: true, data: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Rapid Consent User');
  await page.getByLabel('Email').fill('rapid-consent@example.com');
  await page.getByLabel('Mobile number').fill('01712345678');
  await page.getByLabel('Password').fill('ValidPass123!');
  await page.getByRole('checkbox', { name: /privacy policy/i }).check();

  await page.locator('form').evaluate((form) => {
    if (!(form instanceof HTMLFormElement)) throw new Error('Signup form was not found');
    form.requestSubmit();
    form.requestSubmit();
  });

  await expect.poll(() => signupRequests.length).toBe(1);
  expect(JSON.parse(signupRequests[0].body ?? '{}')).toMatchObject({ accepted_terms: true });
});
