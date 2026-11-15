import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Static apex zero-landing smoke proof (ADR-0014).
 *
 * The production apex "/" is served by a Caddy internal rewrite to this static
 * file; the dev server exposes it at its public/ path. These tests guard the
 * file itself — design markers, calculator, FAQ, drawer, reduced-motion and
 * axe — not the edge rewrite (that is proven post-deploy against production).
 *
 * No backend, no contract fetch: the page is static by design. Contract price
 * parity is enforced separately by verify-claims check (h).
 */

const PATH = '/landing-zero.html';
const SIGNUP_HREF = '/signup?source=landing_zero&offer=delivered_10';

async function openStatic(page: Page, width = 360, height = 800) {
  await page.setViewportSize({ width, height });
  await page.goto(PATH);
  await expect(page).toHaveTitle(/ডেলিভারি না হলে ৳০/);
}

/** Scroll through the page so IntersectionObserver reveals fire, then return to top. */
async function revealAll(page: Page) {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(700);
}

test('S1 — 360px: zero mark, sample disclaimer and signup CTAs render', async ({ page }) => {
  await openStatic(page, 360, 800);
  await expect(page.locator('.zero .digit')).toHaveText('০');
  await expect(page.locator('.sflag').first()).toContainText('নমুনা স্ক্রিন · আসল ডেটা নয়');
  await expect(page.locator('.sampn')).toContainText('কোনো মার্চেন্টের প্রকৃত ফলাফল নয়');
  const ctas = page.locator('a.js-cta[href^="/signup"]');
  expect(await ctas.count()).toBeGreaterThan(3);
  for (const href of await ctas.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
    expect(href).toBe(SIGNUP_HREF);
  }
  // Mobile layout: stacked mechanism cards, no desktop stack.
  await expect(page.locator('.mmob')).toBeVisible();
  await expect(page.locator('.mdesk')).toBeHidden();
});

test('S2 — 1440px: desktop mechanism stack and rail render', async ({ page }) => {
  await openStatic(page, 1440, 900);
  await expect(page.locator('.mdesk')).toBeVisible();
  await expect(page.locator('.mmob')).toBeHidden();
  await expect(page.locator('#rail')).toBeVisible();
  await expect(page.locator('#mstack .msc.active')).toHaveCount(1);
});

test('S3 — calculator recomputes from slider input', async ({ page }) => {
  await openStatic(page, 1440, 900);
  await page.locator('#calc').scrollIntoViewIfNeeded();
  // Defaults: 500 orders × 25% returns → 375 delivered → bill ৳৩,৭৫০.
  await expect(page.locator('#oBill')).toHaveText('৳৩,৭৫০');
  await page.locator('#fOrd').evaluate((el: HTMLInputElement) => {
    el.value = '1000';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#vOrd')).toHaveText('১,০০০টি');
  // 1000 × 25% = 250 returns → 750 delivered → bill ৳৭,৫০০; cost 250 × ৳105.
  await expect(page.locator('#oBill')).toHaveText('৳৭,৫০০');
  await expect(page.locator('#oCost')).toHaveText('৳২৬,২৫০');
  await expect(page.locator('#oBack')).toHaveText('২৫০');
  // Reset restores defaults.
  await page.locator('#reset').click();
  await expect(page.locator('#oBill')).toHaveText('৳৩,৭৫০');
});

test('S4 — FAQ accordion toggles aria-expanded', async ({ page }) => {
  await openStatic(page, 360, 800);
  const q2 = page.locator('#q2');
  await q2.scrollIntoViewIfNeeded();
  await expect(q2).toHaveAttribute('aria-expanded', 'false');
  await q2.click();
  await expect(q2).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#a2')).toContainText('মাসিক ন্যূনতম বিল নেই');
  await q2.click();
  await expect(q2).toHaveAttribute('aria-expanded', 'false');
});

test('S5 — mobile drawer opens, closes on Escape', async ({ page }) => {
  await openStatic(page, 360, 800);
  const burger = page.locator('#burger');
  await burger.click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await expect(burger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  await expect(burger).toHaveAttribute('aria-expanded', 'false');
});

test('S6 — reduced motion: reveals and hero thread settle immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openStatic(page, 360, 800);
  const total = await page.locator('.rv').count();
  await expect(page.locator('.rv.in')).toHaveCount(total);
  const nodes = await page.locator('#thread .tn').count();
  await expect(page.locator('#thread .tn.on')).toHaveCount(nodes);
});

test('S7 — no uncaught JS exceptions through a full interaction pass', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await openStatic(page, 360, 800);
  await revealAll(page);
  await page.locator('#burger').click();
  await page.keyboard.press('Escape');
  await page.locator('#q1').scrollIntoViewIfNeeded();
  await page.locator('#q1').click();
  await page.locator('#fRate').evaluate((el: HTMLInputElement) => {
    el.value = '40';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

for (const width of [360, 1440]) {
  test(`S8 — axe reports zero critical violations at ${width}px`, async ({ page }) => {
    await openStatic(page, width, width === 360 ? 800 : 900);
    await revealAll(page);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(critical, JSON.stringify(critical.map((v) => v.id))).toEqual([]);
  });
}
