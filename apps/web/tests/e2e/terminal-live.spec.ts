import { expect, test } from "@playwright/test";

test.skip(!process.env.PTY_BROWSER_API, "Needs the isolated Linux real-Ratatui fixture");
for (const width of [390, 900, 1440]) test(`original Ratatui renders and accepts input at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/ws/demo/main?as=alice&api=${encodeURIComponent(process.env.PTY_BROWSER_API!)}`);
  await page.getByRole("button", { name: "Show editor", exact: true }).click();
  await page.getByRole("button", { name: "Toggle terminal" }).click();
  const terminal = page.getByRole("region", { name: "Workspace terminal" });
  await expect(terminal.getByRole("status")).toHaveText("Interactive Ratatui", { timeout: 30_000 });
  await expect(terminal).toContainText("Pineagent", { timeout: 15_000 });
  await terminal.locator("textarea").focus();
  await page.keyboard.type("read value.txt", { delay: 50 });
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("file:snapshot:", { timeout: 15_000 });
  if (width === 1440) await expect(terminal).toContainText("Ratatui reads through");
  await page.setViewportSize({ width: width + 40, height: 950 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/ratatui-${width}.png` });
  await page.keyboard.press("Escape");
  await expect(terminal.getByRole("status")).toContainText("Terminal ended");
});
