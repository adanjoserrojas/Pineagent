import { expect, test, type Page } from "@playwright/test";
import { expandTo, home, openFile } from "./rooms";

const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const row = (page: Page, path: string) => tree(page).locator(`[data-path="${path}"]`);
const explorer = (page: Page) => page.getByRole("navigation", { name: "Explorer" });

// Starts the inline "new file" row; the box is focused and typed into like a user would.
async function startNew(page: Page, kind: "file" | "folder", name?: string) {
  await page.getByRole("button", { name: kind === "file" ? "New file" : "New folder" }).click();
  const box = page.getByRole("textbox", { name: kind === "file" ? "New file name" : "New folder name" });
  await expect(box).toBeFocused();
  if (name) await box.pressSequentially(name);
  return box;
}

test("folders start collapsed; Expand all and Collapse all work", async ({ page }) => {
  await page.goto(home("alice"));
  await expect(row(page, "src/")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "src/auth.ts")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all folders" }).click();
  await expect(row(page, "src/routes/users.ts")).toBeVisible();
  await page.getByRole("button", { name: "Collapse all folders" }).click();
  await expect(row(page, "src/auth.ts")).toHaveCount(0);
});

test("opening a file from the filter reveals its row, folders opened on the way", async ({ page }) => {
  await page.goto(home("alice"));
  await expect(row(page, "src/")).toBeVisible();
  await openFile(page, "src/routes/users.ts");
  await expect(row(page, "src/")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "src/routes/users.ts")).toBeInViewport();
  await expect(row(page, "src/routes/users.ts")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox", { name: "Filter files" })).toBeFocused(); // reveal doesn't steal focus
});

test("shows nested folders and collapses them with the keyboard", async ({ page }) => {
  await page.goto(home("alice"));
  await expandTo(page, "src/routes/users.ts");
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
  await expect(row(page, "src/")).toBeVisible();
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
  await expandTo(page, "src/auth.ts");
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
  await expandTo(page, "src/auth.ts");
  await expandTo(bob, "src/auth.ts");
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

test("uncommitted changes show an M on the file and a dot on its folders, for everyone; Changed lists them", async ({ page, browser }) => {
  await page.goto(home("alice"));
  const bob = await (await browser.newContext()).newPage();
  await bob.goto(home("bob"));
  await expandTo(page, "src/auth.ts");
  await expandTo(bob, "src/auth.ts");
  await expect(row(bob, "src/auth.ts")).toBeVisible();
  await expect(bob.getByRole("radio", { name: "Changed · 0" })).toBeVisible();

  await row(page, "src/auth.ts").click();
  await expect(page.getByTestId("editor-status")).toContainText("Viewing");
  await page.locator(".monaco-editor .view-line").first().click({ position: { x: 2, y: 5 } });
  await page.keyboard.type("// hi\n");
  await expect(page.getByTestId("editor-status")).toContainText("saved");

  await expect(row(bob, "src/auth.ts").getByTestId("git-status")).toHaveText("Mmodified");
  await expect(row(bob, "src/").getByTestId("git-status")).toBeAttached();
  await expect(row(bob, "src/routes/").getByTestId("git-status")).toHaveCount(0);
  await expect(row(bob, "src/db.ts").getByTestId("git-status")).toHaveCount(0);

  await bob.getByRole("radio", { name: "Changed · 1" }).click();
  await expect(tree(bob).getByRole("treeitem")).toHaveCount(1);
  await expect(row(bob, "src/auth.ts")).toBeVisible();

  // Once alice commits, the letter goes away for both of them.
  await page.getByRole("button", { name: "Release lock" }).click();
  await page.getByRole("button", { name: /^Commit, / }).click();
  await page.getByLabel("Commit message").fill("hi");
  await page.getByRole("button", { name: "Commit 1 file" }).click();
  await expect(bob.getByText("No uncommitted changes on this branch.")).toBeVisible();
  await expect(row(page, "src/auth.ts").getByTestId("git-status")).toHaveCount(0);
  await bob.context().close();
});

test("creates a file and a folder from the explorer, and others see them", async ({ page, browser }) => {
  await page.goto(home("alice"));
  const bob = await (await browser.newContext()).newPage();
  await bob.goto(home("bob"));
  await expect(row(page, "src/")).toBeVisible();
  await expect(row(bob, "src/")).toBeVisible();

  // With nothing picked the row sits at the top of the repo root. A nested name makes the folders too;
  // the file opens in the editor and is marked as added.
  const field = await startNew(page, "file");
  await expect(tree(page).locator("li").first()).toHaveClass(/tree-create/);
  await field.fill("src/utils/date.ts");
  await field.press("Enter");
  await expect(row(page, "src/utils/date.ts")).toBeVisible();
  await expect(page.getByRole("tab", { name: "src/utils/date.ts" })).toBeVisible();
  await expect(row(page, "src/utils/date.ts")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "src/utils/date.ts").getByTestId("git-status")).toHaveText(/A/);
  await expandTo(bob, "src/utils/date.ts");
  await expect(row(bob, "src/utils/date.ts")).toBeVisible();

  // A new folder goes inside the folder you picked; the same name twice is refused.
  await expandTo(page, "src/routes/users.ts");
  await row(page, "src/routes/").click();
  const dirField = await startNew(page, "folder", "v2");
  await dirField.press("Enter");
  await expect(row(page, "src/routes/v2/")).toBeVisible();
  await expect(row(page, "src/routes/v2/")).toBeFocused();
  await expandTo(bob, "src/routes/v2/");
  await expect(row(bob, "src/routes/v2/")).toBeVisible();

  await row(page, "src/routes/").click();
  const again = await startNew(page, "folder", "v2");
  await again.press("Enter");
  await expect(explorer(page).getByRole("alert")).toContainText("“v2” already exists");
  await again.press("Escape");
  await expect(again).toHaveCount(0);

  // The empty folder is still there after a reload, even though Git doesn't track it.
  await page.reload();
  await expandTo(page, "src/routes/v2/");
  await expect(row(page, "src/routes/v2/")).toBeVisible();
});

test("the new-file row goes in the selected folder, one level in", async ({ page }) => {
  await page.goto(home("alice"));
  await expandTo(page, "src/routes/users.ts");
  await row(page, "src/routes/").click(); // closes it
  await expect(row(page, "src/routes/")).toHaveAttribute("aria-expanded", "false");
  const field = await startNew(page, "file", "health.ts");
  // Opened again for the new row, right under its folder, with the child indent (10 + 2 * 16).
  await expect(row(page, "src/routes/")).toHaveAttribute("aria-expanded", "true");
  const line = tree(page).locator('[data-path="src/routes/"] + li.tree-create');
  await expect(line).toHaveCSS("padding-left", "42px");
  await field.press("Enter");
  await expect(row(page, "src/routes/health.ts")).toBeVisible();
  await expect(page.getByRole("tab", { name: "src/routes/health.ts" })).toBeVisible();

  // A selected file means its parent folder.
  await row(page, "src/routes/users.ts").click();
  const next = await startNew(page, "file");
  await expect(tree(page).locator('[data-path="src/routes/"] + li.tree-create')).toHaveCount(1);
  await next.press("Escape");
});

test("leaving the new-file box creates when it has text, cancels when empty; Escape cancels", async ({ page }) => {
  await page.goto(home("alice"));
  await expect(row(page, "src/")).toBeVisible();

  const blurred = await startNew(page, "file", "blurred.md");
  await page.getByRole("heading", { name: "Explorer" }).click();
  await expect(row(page, "blurred.md")).toBeVisible();
  await expect(blurred).toHaveCount(0);

  const empty = await startNew(page, "file");
  await page.getByRole("heading", { name: "Explorer" }).click();
  await expect(empty).toHaveCount(0);
  await expect(explorer(page).getByRole("alert")).toHaveCount(0);

  const typed = await startNew(page, "file", "never.md");
  await typed.press("Escape");
  await expect(typed).toHaveCount(0);
  await expect(row(page, "never.md")).toHaveCount(0);
});

test("a refused name keeps the row and explains why right under it", async ({ page }) => {
  await page.goto(home("alice"));
  await expect(row(page, "README.md")).toBeVisible();
  const field = await startNew(page, "file", "README.md");
  await field.press("Enter");
  await expect(explorer(page).getByRole("alert")).toHaveText("A file or folder named “README.md” already exists here.");
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("aria-invalid", "true");

  await field.fill("");
  await field.press("Enter");
  await expect(explorer(page).getByRole("alert")).toHaveText("Type a file name, like notes.md.");
  await field.fill("docs/");
  await field.press("Enter");
  await expect(explorer(page).getByRole("alert")).toHaveText("Type a file name, like notes.md.");
  await field.fill("fresh.md"); // typing clears the message
  await expect(explorer(page).getByRole("alert")).toHaveCount(0);
  await field.press("Enter");
  await expect(row(page, "fresh.md")).toBeVisible();
});

test("a long file list scrolls inside the explorer instead of stretching the page", async ({ page }) => {
  test.setTimeout(60_000); // creates files one by one through the UI
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto(home("alice"));
  await expect(row(page, "src/")).toBeVisible();
  for (let i = 10; i < 30; i++) {
    // The first creates many/; after that the new file is selected, so the next one lands beside it.
    const field = await startNew(page, "file");
    await field.fill(i === 10 ? `many/file-${i}.ts` : `file-${i}.ts`);
    await field.press("Enter");
    await expect(row(page, `many/file-${i}.ts`)).toBeVisible();
  }
  const sizes = () =>
    page.evaluate(() => {
      const list = document.querySelector(".tree-list")!;
      const editor = document.querySelector(".editor-body")!.getBoundingClientRect();
      return { page: document.documentElement.scrollHeight, view: innerHeight, list: list.scrollHeight, shown: list.clientHeight, editorBottom: editor.bottom };
    });
  const s = await sizes();
  expect(s.page).toBeLessThanOrEqual(s.view); // the page itself doesn't scroll
  expect(s.list).toBeGreaterThan(s.shown); // the file list does
  expect(s.editorBottom).toBeLessThanOrEqual(s.view);

  // Scrolling to the end shows the last file while the filter stays in place.
  await expect(row(page, "README.md")).not.toBeInViewport();
  await tree(page).hover();
  await page.mouse.wheel(0, 5000);
  await expect(row(page, "README.md")).toBeInViewport();
  await expect(row(page, "many/")).not.toBeInViewport();
  await expect(page.getByRole("searchbox", { name: "Filter files" })).toBeInViewport();

  // Crown switches mobile panels; the visible explorer keeps its own scroll.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole("button", { name: "Show files", exact: true }).click();
  const phone = await sizes();
  expect(phone.shown).toBeGreaterThan(0);
  expect(phone.shown).toBeLessThan(phone.view);
  expect(phone.list).toBeGreaterThan(phone.shown);
  expect(phone.page).toBeLessThanOrEqual(phone.view);
  await tree(page).hover();
  await page.mouse.wheel(0, 5000);
  await expect(row(page, "README.md")).toBeInViewport();
  await expect(page.getByRole("searchbox", { name: "Filter files" })).toBeInViewport();
});
