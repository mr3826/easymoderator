import { test, expect } from '@playwright/test';
import { fixtures, pageRequest, signIn } from './support';

test.describe.configure({ mode: 'serial' });

test.describe('sign-in experiences', () => {
  test('super admin signs in with password and TOTP', async ({ page }) => {
    await signIn(page, fixtures.users.super);
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect(page.getByText('Growth E2E Super Admin', { exact: true })).toBeVisible();
    await expect(page.getByText('SUPER_ADMIN', { exact: true })).toBeVisible();
  });

  test('legacy founder account signs in via TOTP and resolves to the canonical SUPER_ADMIN role', async ({ page }) => {
    await signIn(page, fixtures.users.legacy);
    const session = await pageRequest(page, '/api/internal/growth-os/session');
    expect(session.status).toBe(200);
    expect(session.body?.data?.role).toBe('SUPER_ADMIN');
    expect(session.body?.data?.legacyRole).toBe('FOUNDER');
    expect(session.body?.data?.permissions).not.toContain('growth_os.admin.users.read');
  });

  test('growth operator signs in with password', async ({ page }) => {
    await signIn(page, fixtures.users.growth);
    await expect(page.getByText('GROWTH_USER', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Growth Users', exact: true })).toHaveCount(0);
  });

  test('merchant account authenticates but is denied the Growth OS workspace', async ({ page }) => {
    await signIn(page, fixtures.users.merchant, { assertAuthorized: false });
    await expect(page).toHaveURL(/\/access-denied$/);
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Growth OS navigation' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Prospects', exact: true })).toHaveCount(0);
  });

  test('wrong password shows the server rejection without granting a session', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('growth-e2e-ghost-user@example.test');
    await page.getByLabel('Password').fill('Wrong-Growth-E2E-Password!');
    const signinResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && response.url().includes('/api/auth/signin')
    ));
    await page.getByRole('button', { name: 'Sign in' }).click();
    const response = await signinResponse;
    expect(response.status()).toBe(401);
    await expect(page.getByText('Invalid email or password', { exact: true })).toBeVisible();
  });
});
