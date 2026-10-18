import { expect, test, type Page } from "@playwright/test";
import { home, openFile } from "./rooms";
import { startMock } from "../../mock/server";

process.env.MOCK_AVATARS = "0";

const code = (page: Page) => page.locator(".monaco-editor .view-lines");

test("fast switches keep the same editor and never flash a loading state", async ({ page }) => {
  await page.goto(home("alice"));
  await openFile(page, "src/auth.ts");
  await expect(code(page)).toContainText("currentUser");

  // Tag the element Monaco was mounted into (Monaco rebuilds its inner .monaco-editor view on every
  // model swap, so that node changes even when the editor instance survives), then record any
  // loading text that appears.
  await page.evaluate(() => {
    document.querySelector(".editor-body .monaco-editor")!.parentElement!.setAttribute("data-instance", "first");
    const seen: string[] = [];
    (window as unknown as { loadingSeen: string[] }).loadingSeen = seen;
    new MutationObserver(() => {
      const el = document.querySelector('.editor-body [role="status"]');
      if (el) seen.push(el.textContent ?? "");
    }).observe(document.body, { subtree: true, childList: true });
  });

  for (const [path, text] of [["src/db.ts", "rows"], ["src/jwt.ts", "verifyToken"], ["src/auth.ts", "currentUser"]]) {
    await openFile(page, path);
    await expect(code(page)).toContainText(text);
  }
  await expect(page.locator('[data-instance="first"] > .monaco-editor')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { loadingSeen: string[] }).loadingSeen)).toEqual([]);
});

test("a slow load dims the previous file, then shows the new one", async ({ page }) => {
  const mock = await startMock({ port: 0, snapshotDelayMs: 900 });
  await page.goto(`/?as=alice&api=http://localhost:${mock.port}`);
  await openFile(page, "src/auth.ts");
  await expect(code(page)).toContainText("currentUser", { timeout: 15_000 }); // cold Monaco + 900 ms server

  await openFile(page, "src/db.ts");
  await expect(page.locator(".editor-loading")).toHaveText("Loading src/db.ts…");
  await expect(code(page)).toContainText("rows");
  await expect(page.locator(".editor-loading")).toHaveCount(0);

  // Revisiting a cached file is instant even though the server is still slow.
  await openFile(page, "src/auth.ts");
  await expect(code(page)).toContainText("currentUser", { timeout: 500 }); // server takes 900 ms, so this proves the cache
  await mock.close();
});
