import { expect, test } from "@playwright/test";
import { home, openFile } from "./rooms";
import { startMock } from "../../mock/server";

test("Crown keeps square controls and a working desktop workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await expect(page.getByRole("heading", { name: "Good work grows here." })).toBeVisible();
  await page.getByRole("button", { name: "Browse files" }).click();
  await expect(page.getByRole("searchbox", { name: "Filter files" })).toBeFocused();
  await openFile(page, "src/auth.ts");
  await expect(page.getByTestId("editor-status")).toContainText("Viewing");
  await expect(page.getByRole("complementary", { name: "Agent runs" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Branch presence" })).toContainText("Viewing src/auth.ts");
  const radii = await page.locator(".topbar-btn, .avatar, .explorer-filter, .branch, .btn-primary").evaluateAll(
    (elements) => elements.map((el) => getComputedStyle(el).borderRadius),
  );
  expect(radii.every((radius) => radius === "0px")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/crown-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Commit to/ })).toBeVisible();
});

test("ownership, approval and reduced motion remain clear in Crown", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await openFile(page, "src/auth.ts");
  await expect(page.getByTestId("editor-status")).toContainText("Viewing");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("currentUser");
  await page.locator(".monaco-editor .view-line").first().click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("// Crown ownership check\n");
  await expect(page.getByTestId("editor-status")).toContainText("Writing");
  await expect(page.locator(".ownership-ribbon")).toContainText("You’re editing");
  await expect(page.getByRole("region", { name: "Branch activity" })).toContainText("src/auth.ts");
  expect(await page.locator(".ownership-ribbon > svg").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.getByLabel("Ask your agent").fill("unsure add a test for db.ts");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByTestId("run-state")).toHaveText("needs a choice");
  await expect(page.getByRole("button", { name: "Run this plan" })).toBeVisible();
  await page.screenshot({ path: "test-results/crown-ownership-approval.png", fullPage: true });
  await page.getByRole("button", { name: "Release lock" }).click();
  await expect(page.getByTestId("editor-status")).toContainText("Viewing");
  await expect(page.locator(".ownership-ribbon")).toContainText("Ready when you are");
});

test("small-screen panel navigation preserves the open file and composer draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await openFile(page, "src/auth.ts");
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

test("disconnected task shortcuts do not queue an unintended run", async ({ page }) => {
  // Browser offline emulation does not reliably close an existing WebSocket.
  // Stop a private mock, just like the reconnect acceptance test.
  let mock = await startMock({ port: 0 });
  const port = mock.port;
  try {
    await page.goto(`${home("alice")}&api=http://localhost:${port}`);
    await expect(page.getByTestId("connection")).toHaveText("Connected");
    await page.getByLabel("Ask your agent").fill("Do not start while offline");
    await mock.close();
    await expect(page.getByTestId("connection")).toHaveText("Reconnecting…");
    await expect(page.getByRole("button", { name: "Start run" })).toBeDisabled();
    await page.getByLabel("Ask your agent").press("Control+Enter");
    mock = await startMock({ port });
    await expect(page.getByTestId("connection")).toHaveText("Connected");
    // A negative assertion needs time for an accidentally buffered command to arrive.
    await page.waitForTimeout(500);
    await expect(page.getByLabel("Ask your agent")).toHaveValue("Do not start while offline");
    await expect(page.locator(".run-card")).toHaveCount(0);
  } finally {
    await mock.close();
  }
});
