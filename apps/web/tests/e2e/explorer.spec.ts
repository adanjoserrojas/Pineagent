import { expect, test, type Page } from "@playwright/test";

const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const row = (page: Page, path: string) => tree(page).locator(`[data-path="${path}"]`);

test("shows nested folders and collapses them with the keyboard", async ({ page }) => {
  await page.goto("/?as=alice");
  await expect(row(page, "src/routes/users.ts")).toBeVisible();
  await expect(row(page, "src/routes/users.ts")).toHaveAttribute("aria-level", "3");

  await row(page, "src/routes/").click(); // toggles closed
  await expect(row(page, "src/routes/users.ts")).toHaveCount(0);
  await row(page, "src/routes/").press("ArrowRight");
  await expect(row(page, "src/routes/users.ts")).toBeVisible();
  await row(page, "src/routes/").press("ArrowLeft");
  await expect(row(page, "src/routes/")).toHaveAttribute("aria-expanded", "false");

  await row(page, "src/routes/").press("ArrowDown");
  await expect(row(page, "src/auth.ts")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row(page, "src/auth.ts")).toHaveAttribute("aria-selected", "true");
});

test("filters with / and opens the first match with Enter", async ({ page }) => {
  await page.goto("/?as=alice");
  await expect(row(page, "src/auth.ts")).toBeVisible();
  await tree(page).locator('[tabindex="0"]').focus();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: "Filter files" })).toBeFocused();
  await page.keyboard.type("user");
  await expect(page.getByText("1 match")).toBeVisible();
  await expect(row(page, "src/routes/users.ts").locator("mark")).toHaveText("user");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: "src/routes/users.ts" })).toBeVisible();
});

test("opening a file loads its contents read-only and switching files swaps them", async ({ page }) => {
  await page.goto("/?as=alice");
  await row(page, "src/auth.ts").click();
  const code = page.locator(".monaco-editor .view-lines");
  await expect(code).toContainText("currentUser");
  await expect(page.getByText("v1", { exact: true })).toBeVisible();

  await row(page, "src/db.ts").click();
  await expect(code).toContainText("rows");
  await expect(code).not.toContainText("currentUser");

  // Read-only until locks land: typing must not change the buffer.
  await code.click();
  await page.keyboard.type("zzz");
  await expect(code).not.toContainText("zzz");
});

test("another person's open file shows their avatar on the row", async ({ page, browser }) => {
  await page.goto("/?as=alice");
  const bob = await (await browser.newContext()).newPage();
  await bob.goto("/?as=bob");
  await expect(row(bob, "src/auth.ts")).toBeVisible();

  await row(page, "src/auth.ts").click();
  await expect(row(bob, "src/auth.ts").getByRole("img", { name: "alice has this open" })).toBeVisible();
  await row(page, "src/db.ts").click();
  await expect(row(bob, "src/auth.ts").getByRole("img", { name: "alice has this open" })).toHaveCount(0);
  await expect(row(bob, "src/db.ts").getByRole("img", { name: "alice has this open" })).toBeVisible();
  await bob.context().close();
});
