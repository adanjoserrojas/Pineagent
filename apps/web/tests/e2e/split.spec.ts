import { expect, test, type Locator } from "@playwright/test";
import { home, openFile } from "./rooms";

async function typeAtStart(group: Locator, text: string) {
  await group.locator(".monaco-editor .view-line").first().click({ position: { x: 2, y: 5 } });
  await group.page().keyboard.press("Control+Home");
  await group.page().keyboard.type(text);
}

test("split groups synchronize one file without duplicate edits and retain surviving locks", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await openFile(page, "src/auth.ts");
  await expect(page.locator(".view-lines")).toContainText("currentUser");
  await page.keyboard.press("Control+Backslash");
  const first = page.getByRole("region", { name: "Editor group 1", exact: true });
  const second = page.getByRole("region", { name: "Editor group 2", exact: true });
  await expect(second.locator(".view-lines")).toContainText("currentUser");
  await typeAtStart(first, "// first group\n");
  await expect(second.locator(".view-lines")).toContainText("// first group");
  await expect(second.getByTestId("editor-status")).toContainText("Writing");
  await typeAtStart(second, "// second group\n");
  await expect(first.locator(".view-lines")).toContainText("// second group");
  await expect.poll(() => page.evaluate(() => {
    const views = (window as unknown as { __editorTexts: Record<string, () => string> }).__editorTexts;
    return views["group-0"]() === views["group-1"]();
  })).toBe(true);
  await expect(page.locator(".workspace-footer")).toContainText("1 active lock");

  const context = await browser.newContext();
  try {
    const bob = await context.newPage();
    await bob.goto(home("bob"));
    await openFile(bob, "src/auth.ts");
    await expect(bob.getByTestId("editor-status")).toContainText("Read-only");
    await expect(bob.locator(".view-lines")).toContainText("// second group");
  } finally { await context.close(); }

  await page.getByRole("button", { name: "Focus editor group 2" }).click();
  await openFile(page, "src/db.ts");
  await expect(second.getByRole("tab", { name: "src/db.ts", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(second.getByTestId("editor-status")).toContainText("Viewing");
  await typeAtStart(second, "// db in second group\n");
  await expect(page.locator(".workspace-footer")).toContainText("2 active locks");
  await expect(first.getByTestId("editor-status")).toContainText("Writing");
  await page.screenshot({ path: "test-results/crown-split.png" });
  await page.getByRole("button", { name: "Close split" }).click();
  await expect(second).toHaveCount(0);
  await expect(first.getByTestId("editor-status")).toContainText("Writing");
  await expect(page.locator(".workspace-footer")).toContainText("1 active lock");
  await page.getByRole("button", { name: "Release lock" }).click();
  await expect(page.locator(".workspace-footer")).toContainText("0 active locks");
  await page.keyboard.press("Control+b");
  await expect(page.getByRole("navigation", { name: "Explorer", exact: true })).toBeHidden();
  await page.keyboard.press("Control+Alt+b");
  await expect(page.getByRole("complementary", { name: "Agent runs" })).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("region", { name: "Branch activity" })).toBeHidden();
});

test("stacked splits resize by keyboard and reflow on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(home("alice"));
  await openFile(page, "src/auth.ts");
  await page.getByRole("button", { name: "Split editor down" }).click();
  const handle = page.getByRole("separator", { name: "Resize editor split" });
  await expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  const before = Number(await handle.getAttribute("aria-valuenow"));
  await handle.press("ArrowDown");
  expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(page.getByRole("region", { name: "Editor group 2", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/crown-split-mobile.png" });
});
