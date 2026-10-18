import { expect, test } from "@playwright/test";
import { home, openFile } from "./rooms";

test("Recursive is local, code stays monospaced, and motion honors reduced motion", async ({ page }) => {
  const remoteFonts: string[] = [];
  page.on("request", (request) => { if (/fonts\.google/.test(request.url())) remoteFonts.push(request.url()); });
  await page.goto(home("alice"));
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check("14px 'Recursive Sans'"))).toBe(true);
  await expect(page.locator("body")).toHaveCSS("font-family", /Recursive Sans/);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await page.locator(".workspace-welcome .crown-leaves").evaluate((el) => getComputedStyle(el).animationName)).toBe("crown-breathe");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator(".workspace-welcome .crown-leaves").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await openFile(page, "src/auth.ts");
  await expect(page.locator(".view-lines")).toContainText("currentUser");
  await page.evaluate(() => document.fonts.load("14px 'Recursive Mono'"));
  await expect(page.locator(".monaco-editor .view-lines")).toHaveCSS("font-family", /Recursive Mono/);
  const widths = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = "14px 'Recursive Mono'";
    return [context.measureText("iiiiiiii").width, context.measureText("WWWWWWWW").width];
  });
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(0.1);
  expect(remoteFonts).toEqual([]);
  await page.screenshot({ path: "test-results/crown-recursive.png" });
});
