import { expect, test } from "@playwright/test";

for (const width of [390, 900, 1440]) test(`terminal is keyboard-accessible at ${width}px and reports unavailable honestly`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/ws/demo/main?as=alice");
  await page.getByRole("button", { name: "Show editor", exact: true }).click();
  const toggle = page.getByRole("button", { name: "Toggle terminal" });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  const terminal = page.getByRole("region", { name: "Workspace terminal" });
  await expect(terminal).toBeVisible();
  const input = terminal.locator("textarea");
  await expect(input).toBeFocused();
  await page.keyboard.type("runs");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("Terminal not enabled on this server.");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/terminal-${width}.png` });
  await page.getByRole("button", { name: "Close terminal" }).click();
  await expect(terminal).toHaveCount(0);
});
