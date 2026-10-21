import { expect, type Page, type TestType } from '@playwright/test';

// Fails each test in the calling spec that trips the Content-Security-Policy, so a feature the
// policy blocks shows up as a red spec instead of something that quietly stops working.
export function failOnCspViolation(test: TestType<{ page: Page }, object>): void {
  const seen = new WeakMap<Page, string[]>();
  test.beforeEach(async ({ page }) => {
    const violations: string[] = [];
    seen.set(page, violations);
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`);
      });
    });
  });
  test.afterEach(async ({ page }) => {
    expect(seen.get(page) ?? []).toEqual([]);
  });
}

// Reads the policy the page runs under, so a spec can prove it is in force.
export async function pagePolicy(page: Page): Promise<string | null> {
  return page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
}
