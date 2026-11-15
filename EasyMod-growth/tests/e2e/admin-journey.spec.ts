import { test, expect } from '@playwright/test';
import {
  authStatePath,
  fixtures,
  pageRequest,
  runStamp,
  signIn,
} from './support';

test.describe.configure({ mode: 'serial' });
test.use({ storageState: authStatePath('super') });

const created: { email: string; fullName: string; password: string }[] = [];

async function createUserViaUi(
  page: import('@playwright/test').Page,
  options: { email: string; fullName: string; role: 'growth' | 'admin'; reason: string },
): Promise<string> {
  await page.goto('/growth-users');
  await expect(page.getByRole('heading', { name: 'Growth OS users' })).toBeVisible();
  await page.locator('summary:has-text("Add a Growth OS user")').click();
  await page.locator('#create-email').fill(options.email);
  await page.locator('#create-full-name').fill(options.fullName);
  await page.locator(options.role === 'admin' ? '#create-role-admin' : '#create-role-growth').check();
  await page.locator('#create-reason').fill(options.reason);
  const createResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && response.url().endsWith('/api/internal/growth-os/admin/users')
    && response.status() === 201
  ));
  await page.getByRole('button', { name: 'Create user' }).click();
  await createResponse;
  await expect(page.getByRole('heading', { name: `Initial password for ${options.fullName}` })).toBeVisible();
  const initialPassword = (await page.locator('.password-reveal').innerText()).trim();
  expect(initialPassword.length).toBeGreaterThanOrEqual(20);
  await page.getByRole('button', { name: 'Done — I copied the password' }).click();
  return initialPassword;
}

test('super creates a growth user and finds it in the grant table', async ({ page }) => {
  const stamp = runStamp();
  const fullName = `E2E Fresh Analyst ${stamp}`;
  const email = `growth-e2e-fresh-${stamp}@example.test`;
  const initialPassword = await createUserViaUi(page, {
    email,
    fullName,
    role: 'growth',
    reason: 'Onboarded during browser E2E.',
  });
  created.push({ email, fullName, password: initialPassword });

  await page.getByLabel('Search users').fill(email);
  await page.getByRole('button', { name: 'Apply search' }).click();
  const row = page.locator('tr', { hasText: email });
  await expect(row).toBeVisible();
  await expect(row.getByText(fullName, { exact: true })).toBeVisible();
  await expect(row.getByText('GROWTH USER', { exact: true })).toBeVisible();
  await expect(row.getByText('active', { exact: true })).toBeVisible();
  await expect(row.getByText('No', { exact: true })).toBeVisible();
});

test('the created user is server-enforced GROWTH_USER; suspend and revoke deny further access', async ({ page, browser }) => {
  expect(created.length).toBe(1);
  const fresh = created[0];

  const createdContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const createdPage = await createdContext.newPage();
  // MFA is no longer a Growth OS precondition: a password-only GROWTH_USER
  // session goes straight into the ledger.
  const initialSignIn = await signIn(
    createdPage,
    { id: '', email: fresh.email, password: fresh.password, role: 'GROWTH_USER' },
    { assertAuthorized: false },
  );
  if (initialSignIn.signinBody?.requiresPasswordChange || initialSignIn.signinBody?.data?.requiresPasswordChange) {
    await expect(createdPage).toHaveURL(/\/change-password$/);
    const changedPassword = `E2E-Changed-${runStamp()}!`;
    await createdPage.getByLabel('Temporary password').fill(fresh.password);
    await createdPage.getByRole('textbox', { name: 'New password', exact: true }).fill(changedPassword);
    await createdPage.getByRole('textbox', { name: 'Confirm new password', exact: true }).fill(changedPassword);
    const changePasswordResponse = createdPage.waitForResponse((response) => (
      response.request().method() === 'POST'
      && response.url().endsWith('/api/auth/change-password')
      && response.status() === 200
    ));
    await createdPage.getByRole('button', { name: 'Save password' }).click();
    await changePasswordResponse;
    await expect(createdPage).toHaveURL(/\/login$/);
    fresh.password = changedPassword;
    await signIn(
      createdPage,
      { id: '', email: fresh.email, password: fresh.password, role: 'GROWTH_USER' },
      { assertAuthorized: false },
    );
  }

  // No MFA step: the created operator reaches the workspace directly.
  await expect(createdPage.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(createdPage.getByText('GROWTH_USER', { exact: true })).toBeVisible();

  const session = await pageRequest(createdPage, '/api/internal/growth-os/session');
  expect(session.status).toBe(200);
  expect(session.body?.data?.role).toBe('GROWTH_USER');
  expect(session.body?.data?.legacyRole).toBeNull();

  await expect(createdPage.getByRole('link', { name: 'Growth Users', exact: true })).toHaveCount(0);
  await expect(createdPage.getByRole('link', { name: 'Operations', exact: true })).toHaveCount(0);
  await createdPage.goto('/growth-users');
  await expect(createdPage.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect(createdPage.url()).toContain('/growth-users');

  const deniedAdminRead = await pageRequest(createdPage, '/api/internal/growth-os/admin/users');
  expect(deniedAdminRead.status).toBe(403);
  expect(deniedAdminRead.body?.code).toBe('GROWTH_OS_FORBIDDEN');

  // Suspend the user from the Super Admin session.
  await page.goto('/growth-users');
  await expect(page.getByRole('heading', { name: 'Growth OS users', exact: true })).toBeVisible();
  const row = page.locator('tr', { hasText: fresh.email });
  await row.getByRole('button', { name: 'Suspend', exact: true }).click();
  const suspendForm = row.locator('form');
  await suspendForm.locator('[id^="user-reason-suspend-"]').fill('Suspended during browser E2E.');
  await suspendForm.getByRole('button', { name: 'Continue', exact: true }).click();
  const suspendResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && response.url().includes('/admin/users/')
    && response.url().endsWith('/status')
    && response.status() === 200
  ));
  const refreshUsersResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && response.url().endsWith('/api/internal/growth-os/admin/users/search')
    && response.status() === 200
  ));
  await suspendForm.getByRole('button', { name: 'Confirm suspend' }).click();
  await Promise.all([suspendResponse, refreshUsersResponse]);
  const suspendedRow = page.locator('tr', { hasText: fresh.email });
  await expect(suspendedRow.getByText('suspended', { exact: true })).toBeVisible();

  // The suspended user's live session is revoked server-side, not client-side.
  const invalidated = await pageRequest(createdPage, '/api/internal/growth-os/session');
  expect(invalidated.status).toBe(401);
  await createdPage.goto('/');
  await expect(createdPage).toHaveURL(/\/login$/);
  await expect(createdPage.getByRole('heading', { name: 'Growth OS', exact: true })).toBeVisible();
  await createdContext.close();

  // A fresh sign-in attempt is refused by the server itself (no shops and no
  // active role), so the denial is observable in the HTTP contract.
  const deniedOnce = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const deniedPage = await deniedOnce.newPage();
  const denial = await signIn(deniedPage, { id: '', email: fresh.email, password: fresh.password, role: null }, {
    assertAuthorized: false,
    expectSigninDenied: true,
  });
  expect(denial.signinStatus).toBe(403);
  expect(denial.signinBody?.message).toContain('no associated shops');
  await deniedOnce.close();

  // Permanent revocation from the Super Admin console.
  const revokedRow = page.locator('tr', { hasText: fresh.email });
  await revokedRow.getByRole('button', { name: 'Revoke access', exact: true }).click();
  const revokeForm = revokedRow.locator('form');
  await revokeForm.locator('[id^="user-reason-revoke-"]').fill('Terminal revocation during browser E2E.');
  await revokeForm.locator('[id^="user-revoke-confirm-"]').fill('REVOKE');
  const revokeResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && response.url().includes('/revoke-access')
    && response.status() === 200
  ));
  await revokeForm.getByRole('button', { name: 'Revoke access permanently' }).click();
  await revokeResponse;
  const finalRow = page.locator('tr', { hasText: fresh.email });
  await expect(finalRow.getByText('revoked', { exact: true })).toBeVisible();
  await expect(finalRow.getByText('Access revoked — no further actions.')).toBeVisible();

  const deniedAgain = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const deniedAgainPage = await deniedAgain.newPage();
  const secondDenial = await signIn(deniedAgainPage, { id: '', email: fresh.email, password: fresh.password, role: null }, {
    assertAuthorized: false,
    expectSigninDenied: true,
  });
  expect(secondDenial.signinStatus).toBe(403);
  await deniedAgain.close();
});

test('internal search finds a Growth user and the seeded merchant for super admins', async ({ page }) => {
  const searchableUser = fixtures.users.growth.email;

  await page.goto('/');
  await page.getByLabel('Global internal search').fill(searchableUser);
  await page.getByLabel('Global internal search').press('Enter');
  await expect(page).toHaveURL(/\/search$/);
  const usersGroup = page.locator('section[aria-label="Platform user results"]');
  await expect(usersGroup.getByText(searchableUser, { exact: true })).toBeVisible();

  await page.getByLabel('Search query').fill(fixtures.shop.uniqueCode);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/search$/);
  const merchantGroup = page.locator('section[aria-label="Merchant results"]');
  await expect(merchantGroup.getByRole('link', { name: fixtures.shop.shopName })).toBeVisible();
});

test('a super admin created without MFA reaches the workspace after password rotation', async ({ page, browser }) => {
  const stamp = runStamp();
  const fullName = `E2E Needs MFA Admin ${stamp}`;
  const email = `growth-e2e-needs-mfa-${stamp}@example.test`;
  const initialPassword = await createUserViaUi(page, {
    email,
    fullName,
    role: 'admin',
    reason: 'Password-only access regression during browser E2E.',
  });

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const unenrolled = await context.newPage();
  const initialSignIn = await signIn(unenrolled, {
    id: '', email, password: initialPassword, role: 'SUPER_ADMIN',
  }, { assertAuthorized: false });
  let password = initialPassword;
  if (initialSignIn.signinBody?.requiresPasswordChange || initialSignIn.signinBody?.data?.requiresPasswordChange) {
    await expect(unenrolled).toHaveURL(/\/change-password$/);
    password = `E2E-Changed-${runStamp()}!`;
    await unenrolled.getByLabel('Temporary password').fill(initialPassword);
    await unenrolled.getByRole('textbox', { name: 'New password', exact: true }).fill(password);
    await unenrolled.getByRole('textbox', { name: 'Confirm new password', exact: true }).fill(password);
    const changePasswordResponse = unenrolled.waitForResponse((response) => (
      response.request().method() === 'POST'
      && response.url().endsWith('/api/auth/change-password')
      && response.status() === 200
    ));
    await unenrolled.getByRole('button', { name: 'Save password' }).click();
    await changePasswordResponse;
    await expect(unenrolled).toHaveURL(/\/login$/);
    await signIn(unenrolled, { id: '', email, password, role: 'SUPER_ADMIN' }, { assertAuthorized: false });
  }
  await expect(unenrolled.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(unenrolled.getByText('SUPER_ADMIN', { exact: true })).toBeVisible();
  const session = await pageRequest(unenrolled, '/api/internal/growth-os/session');
  expect(session.status).toBe(200);
  expect(session.body?.data?.role).toBe('SUPER_ADMIN');
  await context.close();
});

test('merchant 360 renders owner email, Meta channels, growth linkage, and editable shop notes for super admins', async ({ page }) => {
  const stamp = runStamp();
  await page.goto('/merchants');
  await expect(page.getByRole('heading', { name: 'Merchants', exact: true })).toBeVisible();
  await expect(page.getByText('Full admin records', { exact: true })).toBeVisible();
  const adminRow = page.locator('tr', { hasText: fixtures.shop.shopName });
  await adminRow.getByRole('link', { name: fixtures.shop.shopName }).click();

  await expect(page.getByText('Merchant 360', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: fixtures.shop.shopName, exact: true })).toBeVisible();
  await expect(page.getByText(`Code ${fixtures.shop.uniqueCode}`, { exact: true })).toBeVisible();
  await expect(page.getByText(fixtures.users.merchant.email, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Meta / Facebook channels' })).toBeVisible();
  await expect(page.getByText('No Meta channels are connected to this shop.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: fixtures.prospects.converted.businessName })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Administrative actions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspend merchant' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Grant credits' })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Internal notes' })).toBeVisible();
  const noteText = `E2E 360 shop note ${stamp}`;
  await page.locator('#merchant-new-note').fill(noteText);
  const noteResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && response.url().endsWith('/api/internal/growth-os/notes')
    && response.status() === 201
  ));
  await page.getByRole('button', { name: 'Add note' }).click();
  await noteResponse;
  await expect(page.locator('section[aria-labelledby="notes-title"]')).toContainText(noteText);
});
