import { expect, test, type Page } from "@playwright/test";
import { home, openFile } from "./rooms";

async function editFile(page: Page, path: string, text: string) {
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await expect(page.getByRole("tree", { name: "Files" }).getByRole("treeitem").first()).toBeVisible();
  await openFile(page, path);
  await expect(page.getByTestId("editor-status")).toContainText("Viewing", { timeout: 15_000 }); // first Monaco load can be slow
  await page.locator(".monaco-editor .view-line").first().click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await page.keyboard.type(text);
}

const members = (page: Page) => page.getByRole("list", { name: "People in this branch" });
const commitBtn = (page: Page) => page.locator(".commit-top");

test("clicking a teammate's avatar shows what they are doing and jumps to their file", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await alice.goto(home("alice"));
  await bob.goto(home("bob"));
  await editFile(bob, "src/auth.ts", "// bob\n");

  await members(alice).getByRole("button", { name: /^bob/ }).click();
  const card = alice.getByRole("dialog", { name: "bob" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Editing src/auth.ts");
  await expect(card.getByRole("link")).toHaveCount(0); // dev users have no GitHub profile

  await card.getByRole("button", { name: "Go to auth.ts" }).click();
  await expect(card).toHaveCount(0);
  await expect(alice.getByTestId("editor-status")).toContainText("Read-only · bob is editing", { timeout: 15_000 });
});

test("Escape closes the card and returns focus to the avatar; your own card has no Go to", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(home("alice"));
  await editFile(page, "src/auth.ts", "");
  const me = members(page).getByRole("button", { name: /^You/ });
  await me.click();
  const card = page.getByRole("dialog", { name: /alice/ });
  await expect(card).toContainText("(you)");
  await expect(card).toContainText(/Viewing src\/auth\.ts|Editing src\/auth\.ts/);
  await expect(card.getByRole("button")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(me).toBeFocused();
  await me.click();
  await expect(card).toBeVisible();
  await me.click();
  await expect(card).toHaveCount(0);
});

test("the commit button counts what you can commit and offers Push after a local commit", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(home("alice"));
  await expect(commitBtn(page)).toHaveAccessibleName("Commit, nothing to commit");
  await editFile(page, "src/auth.ts", "// counted\n");
  await expect(commitBtn(page)).toHaveAccessibleName("Commit, 1 file ready");
  await expect(commitBtn(page).locator(".commit-badge")).toHaveText("1");

  await page.keyboard.press("Control+Shift+K");
  const dialog = page.getByRole("dialog", { name: /Commit to/ });
  await expect(dialog.getByText(/Your changes/)).toBeVisible();
  await dialog.getByLabel("Commit message").fill("Counted");
  await dialog.getByRole("button", { name: "Commit 1 file" }).click();
  await expect(dialog.getByText(/^Committed [0-9a-f]{7}\.$/)).toBeVisible();
  await expect(commitBtn(page)).toContainText("Push 1");
  await expect(commitBtn(page).locator(".commit-badge")).toHaveCount(0);
});
