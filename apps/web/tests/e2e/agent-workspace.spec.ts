import { expect, test } from "@playwright/test";
import { home } from "./rooms";

test("task view grows by drag and keyboard, persists, and keeps drafts on short screens", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 960 });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await page.getByRole("button", { name: "Show agents", exact: true }).click();
  const handle = page.getByRole("separator", { name: "Resize task view", exact: true });
  await page.getByLabel("Ask your agent").fill("Keep the draft");
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 75, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await page.locator(".run-feed").boundingBox())!.height).toBeGreaterThan(350);
  const before = Number(await handle.getAttribute("aria-valuenow"));
  await handle.press("ArrowDown");
  await expect(handle).toHaveAttribute("aria-valuenow", String(before + 10));
  await expect(page.getByLabel("Ask your agent")).toHaveValue("Keep the draft");
  await page.setViewportSize({ width: 390, height: 600 });
  await page.getByRole("button", { name: "Start run", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Start run", exact: true })).toBeInViewport();
  await expect(page.getByLabel("Ask your agent")).toHaveValue("Keep the draft");
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await page.getByRole("button", { name: "Show agents", exact: true }).click();
  await expect(handle).toHaveAttribute("aria-valuenow", String(before + 10));
  await handle.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "180");
});

test("agent workspace resizes beside the editor in a narrow desktop panel", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 960 });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await page.getByRole("button", { name: "Show agents" }).click();
  await page.getByLabel("Ask your agent").fill("Keep this draft while resizing");
  const handle = page.getByRole("separator", { name: "Resize agents", exact: true });
  await expect(handle).toBeVisible();
  const before = await page.locator(".agent-column").boundingBox();
  await handle.press("ArrowLeft");
  await expect.poll(async () => (await page.locator(".agent-column").boundingBox())!.width).toBeGreaterThan(before!.width);
  await expect(page.locator(".workspace-main")).toBeVisible();
  await expect(page.getByLabel("Ask your agent")).toHaveValue("Keep this draft while resizing");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/agents-tablet.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toBeHidden();
  await expect(page.getByLabel("Ask your agent")).toHaveValue("Keep this draft while resizing");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/agents-phone.png" });
});

test("agent workspace can use spare desktop width and persists its size", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await page.getByRole("button", { name: "Collapse explorer" }).click();
  const handle = page.getByRole("separator", { name: "Resize agents", exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 300, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await page.locator(".agent-column").boundingBox())!.width).toBeGreaterThan(520);
  const width = (await page.locator(".agent-column").boundingBox())!.width;
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await expect.poll(async () => (await page.locator(".agent-column").boundingBox())!.width).toBe(width);
  await page.screenshot({ path: "test-results/agents-desktop.png" });
});

test("short phone screens keep the composer reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await page.getByRole("button", { name: "Show agents" }).click();
  await page.getByLabel("Ask your agent").fill("A short-screen draft");
  const button = page.getByRole("button", { name: "Start run" });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  await expect(page.getByLabel("Ask your agent")).toHaveValue("A short-screen draft");
});

test("plant uses a readable state animation and switches to a still for reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  const face = page.getByRole("img", { name: "Plant face: Idle", exact: true });
  await expect.poll(() => face.evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(/idle-loop.*\.gif/);
  await expect.poll(() => face.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect((await face.boundingBox())!.width).toBeGreaterThanOrEqual(160);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => face.evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(/^data:image\/svg/);
  await expect(face).toBeVisible();
});
