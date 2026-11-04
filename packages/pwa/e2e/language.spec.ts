import { test, expect } from '@playwright/test';
import { fr } from '../src/core/i18n/fr';

// The app follows the phone's language: WebKit reports the context locale as navigator.language.
test.describe('on a French phone', () => {
  test.use({ locale: 'fr-FR' });

  test('speaks French from the first screen, and Settings can switch it back', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await page.getByRole('button', { name: fr.home.addMachine }).click();
    const picker = page.getByLabel(fr.settings.language);
    await picker.selectOption('en');
    await expect(page.getByLabel('Language')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page.reload();
    await expect(page.getByRole('button', { name: '⚙ Add a machine' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
