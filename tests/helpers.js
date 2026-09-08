// @ts-check
// v0.6 "Studio" made Make (#studio) the default view, so any spec that
// exercises workbench DOM must open the Workbench first. Contract:
// docs/v06-studio-contracts.md §S5 (and the §S1 view switch it drives).
const { expect } = require('@playwright/test');

/**
 * Opens the Workbench view: clicks #view-workbench, then waits until
 * #main-content is actually visible and #studio is hidden.
 *
 * Idempotent and cheap on purpose — it runs in dozens of beforeEach blocks,
 * and the persisted view means a relaunched app may already be showing the
 * Workbench: if it is, this returns immediately without clicking anything.
 *
 * @param {import('@playwright/test').Page} page
 */
async function openWorkbench(page) {
  const workbench = page.locator('#main-content');
  const studio = page.locator('#studio');
  if ((await workbench.isVisible()) && !(await studio.isVisible())) return;
  await page.locator('#view-workbench').click();
  await expect(workbench).toBeVisible();
  await expect(studio).toBeHidden();
}

module.exports = { openWorkbench };
