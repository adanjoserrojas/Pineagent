import { expect, test, type Page } from "@playwright/test";
import { home } from "./rooms";

const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const row = (page: Page, path: string) => tree(page).locator(`[data-path="${path}"]`);

test("shows nested folders and collapses them with the keyboard", async ({ page }) => {
  await page.goto(home("alice"));
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
  await page.goto(home("alice"));
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

test("opening a file loads its contents and switching files swaps them", async ({ page }) => {
  await page.goto(home("alice"));
  await row(page, "src/auth.ts").click();
  const code = page.locator(".monaco-editor .view-lines");
  await expect(code).toContainText("currentUser");
  await expect(page.getByText("v1", { exact: true })).toBeVisible();

  await row(page, "src/db.ts").click();
  await expect(code).toContainText("rows");
  await expect(code).not.toContainText("currentUser");
});

test("another person's open file shows their avatar on the row", async ({ page, browser }) => {
  await page.goto(home("alice"));
  const bob = await (await browser.newContext()).newPage();
  await bob.goto(home("bob"));
  await expect(row(bob, "src/auth.ts")).toBeVisible();

  await row(page, "src/auth.ts").click();
  await expect(row(bob, "src/auth.ts").getByRole("img", { name: "alice has this open" })).toBeVisible();
  await row(page, "src/db.ts").click();
  await expect(row(bob, "src/auth.ts").getByRole("img", { name: "alice has this open" })).toHaveCount(0);
  await expect(row(bob, "src/db.ts").getByRole("img", { name: "alice has this open" })).toBeVisible();

  // Once alice also holds the lock, her face appears once (on the lock badge), not twice.
  await page.locator(".monaco-editor .view-line").first().click({ position: { x: 2, y: 5 } });
  await page.keyboard.type("x");
  const badge = row(bob, "src/db.ts").getByTestId("lock-badge");
  await expect(badge).toContainText("alice");
  await expect(row(bob, "src/db.ts").getByRole("img", { name: /alice/ })).toHaveCount(1);
  await bob.context().close();
});
