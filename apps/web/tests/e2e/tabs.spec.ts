import { expect, test, type Page } from "@playwright/test";
import { expandTo, home, openFile } from "./rooms";

process.env.MOCK_AVATARS = "0";

// Filtering before the tree has loaded matches nothing, so wait for the root files first.
const ready = (page: Page) => expect(page.getByRole("tree", { name: "Files" }).locator('[data-path="README.md"]')).toBeVisible();
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open files" }).getByRole("tab");
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const code = (page: Page) => page.locator(".monaco-editor .view-lines");
const editorText = (p: Page) => p.evaluate(() => (window as unknown as { __editorText?: () => string }).__editorText?.() ?? null);

test("opening two files gives two tabs, and switching keeps each file's text", async ({ page }) => {
  await page.goto(home("alice"));
  await ready(page);
  await openFile(page, "src/auth.ts");
  await expect(code(page)).toContainText("currentUser", { timeout: 15_000 });
  await openFile(page, "src/db.ts");
  await expect(code(page)).toContainText("rows");
  await expect(tabs(page)).toHaveText(["auth.ts", "db.ts"]);
  await expect(tab(page, "src/db.ts")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "src/auth.ts")).toHaveAttribute("title", "src/auth.ts");

  await tab(page, "src/auth.ts").click();
  await expect(code(page)).toContainText("currentUser");
  await tab(page, "src/db.ts").click();
  await expect(code(page)).toContainText("rows");

  // Opening an already open file activates its tab instead of adding another.
  await openFile(page, "src/auth.ts");
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "src/auth.ts")).toHaveAttribute("aria-selected", "true");
});

test("closing a tab (button or middle click) activates a neighbour", async ({ page }) => {
  await page.goto(home("alice"));
  await ready(page);
  for (const p of ["src/auth.ts", "src/db.ts", "src/jwt.ts"]) await openFile(page, p);
  await expect(tabs(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Close src/jwt.ts" }).click();
  await expect(tabs(page)).toHaveText(["auth.ts", "db.ts"]);
  await expect(tab(page, "src/db.ts")).toHaveAttribute("aria-selected", "true");
  await expect(code(page)).toContainText("rows");
  await tab(page, "src/db.ts").click({ button: "middle" });
  await expect(tabs(page)).toHaveText(["auth.ts"]);
  await expect(code(page)).toContainText("currentUser");
  await page.getByRole("button", { name: "Close src/auth.ts" }).click();
  await expect(page.getByText("Select a file to open it.")).toBeVisible();
});

test("split view shows two files side by side and opens explorer files in the focused group", async ({ page }) => {
  await page.goto(home("alice"));
  await ready(page);
  await openFile(page, "src/auth.ts");
  await expect(code(page)).toContainText("currentUser", { timeout: 15_000 });
  await page.getByRole("button", { name: "Split editor" }).click();
  await expect(page.locator(".editor-group")).toHaveCount(2);
  await openFile(page, "src/db.ts");
  const groups = page.locator(".editor-group");
  await expect(groups.nth(0).locator(".view-lines")).toContainText("currentUser");
  await expect(groups.nth(1).locator(".view-lines")).toContainText("rows");
  const [a, b] = [await groups.nth(0).boundingBox(), await groups.nth(1).boundingBox()];
  expect(b!.x).toBeGreaterThan(a!.x + a!.width - 2); // side by side
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);

  // Clicking the first group focuses it: the next explorer file lands there.
  await groups.nth(0).locator(".view-lines").click();
  await openFile(page, "src/jwt.ts");
  await expect(groups.nth(0).getByRole("tab")).toHaveText(["auth.ts", "jwt.ts"]);
  // A file open in the other group is revealed there, not duplicated.
  await openFile(page, "src/db.ts");
  await expect(groups.nth(1).getByRole("tab", { name: "src/db.ts" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "src/db.ts" })).toHaveCount(1);

  await page.getByRole("button", { name: "Close src/db.ts" }).click();
  await expect(page.locator(".editor-group")).toHaveCount(1);
});

test("groups stack vertically on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto(home("alice"));
  await ready(page);
  await openFile(page, "src/auth.ts");
  await page.getByRole("button", { name: "Split editor" }).click();
  await openFile(page, "src/db.ts");
  const groups = page.locator(".editor-group");
  const [a, b] = [await groups.nth(0).boundingBox(), await groups.nth(1).boundingBox()];
  expect(b!.y).toBeGreaterThan(a!.y + a!.height - 2);
});

test("an image opens in a read-only viewer with its size, and toggles between fit and 100%", async ({ page }) => {
  await page.goto(home("alice"));
  await ready(page);
  await expandTo(page, "images/logo.png");
  await openFile(page, "images/logo.png");
  const info = page.getByTestId("image-info");
  await expect(info).toContainText("48 × 48", { timeout: 15_000 });
  await expect(info).toContainText("KB");
  const img = page.getByRole("img", { name: "images/logo.png" });
  await expect(img).toBeVisible();
  expect(await img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  await expect(page.locator(".monaco-editor")).toHaveCount(0);

  await page.getByRole("button", { name: "100%" }).click();
  await expect(page.locator(".image-actual")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fit" })).toBeVisible();

  await openFile(page, "images/mark.svg");
  await expect(info).toContainText("120 × 120");
  await expect(tabs(page)).toHaveText(["logo.png", "mark.svg"]);
});

test("editing in a tab takes the lock, reaches the other user, and closing the tab releases it", async ({ browser }) => {
  const alice = await browser.newPage();
  const bob = await browser.newPage();
  const url = home("alice");
  await alice.goto(url);
  await bob.goto(url.replace("as=alice", "as=bob"));
  await ready(alice);
  await ready(bob);
  await openFile(alice, "src/auth.ts");
  await openFile(alice, "src/db.ts");
  await expect(code(alice)).toContainText("rows", { timeout: 15_000 });
  await openFile(bob, "src/db.ts");
  await expect(code(bob)).toContainText("rows", { timeout: 15_000 });

  await alice.locator(".monaco-editor .view-line").first().click({ position: { x: 2, y: 5 } });
  await alice.keyboard.press("Home");
  await alice.keyboard.type("// tab edit ");
  await expect(alice.getByTestId("editor-status")).toContainText("Writing");
  await expect.poll(() => editorText(bob)).toContain("// tab edit ");
  await expandTo(bob, "src/db.ts");
  const badge = bob.locator('[data-path="src/db.ts"]').getByTestId("lock-badge");
  await expect(badge).toContainText("alice");

  await alice.getByRole("button", { name: "Close src/db.ts" }).click();
  await expect(badge).toHaveCount(0);
  await alice.context().close();
  await bob.context().close();
});
