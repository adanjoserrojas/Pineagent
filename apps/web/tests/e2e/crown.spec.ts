import { expect, test } from "@playwright/test";
import { home } from "./rooms";

test("Crown keeps square controls and a working desktop workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await expect(page.getByRole("heading", { name: "Good work grows here." })).toBeVisible();
  await page.getByRole("button", { name: "Show files" }).click();
  await expect(page.getByRole("searchbox", { name: "Filter files" })).toBeFocused();
  await page.locator('[data-path="src/auth.ts"]').click();
  await expect(page.getByTestId("editor-status")).toContainText("Viewing");
  await expect(page.getByRole("complementary", { name: "Agent runs" })).toBeVisible();
  const radii = await page.locator(".topbar-btn, .avatar, .explorer-filter, .branch, .btn-primary").evaluateAll(
    (elements) => elements.map((el) => getComputedStyle(el).borderRadius),
  );
  expect(radii.every((radius) => radius === "0px")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/crown-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Commit to/ })).toBeVisible();
});

test("small-screen panel navigation preserves the open file and composer draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await page.locator('[data-path="src/auth.ts"]').click();
  await expect(page.getByTestId("editor-status")).toContainText("Viewing");
  await expect(page.getByRole("navigation", { name: "Explorer", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Show agents" }).click();
  await page.getByLabel("Ask your agent").fill("Keep my task draft");
  await page.getByRole("button", { name: "Show editor" }).click();
  await expect(page.getByTestId("editor-status")).toContainText("Viewing");
  await page.getByRole("button", { name: "Show agents" }).click();
  await expect(page.getByLabel("Ask your agent")).toHaveValue("Keep my task draft");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/crown-mobile.png", fullPage: true });
});
