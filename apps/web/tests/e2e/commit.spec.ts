import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { GitRepo } from "@pineagent/core/server";
import { startMock } from "../../mock/server";

// Release scenario 7: one user cannot commit another user's uncommitted paths.

process.env.MOCK_AVATARS = "0";
const ROOM = "ws:demo:main";

type Mock = Awaited<ReturnType<typeof startMock>>;
let mock: Mock;
let contexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
  await mock?.close();
});

async function joinAs(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`/?as=${name}&api=http://localhost:${mock.port}`);
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  return page;
}

async function editFile(page: Page, path: string, text: string) {
  await page.locator(`[data-path="${path}"]`).click();
  await expect(page.getByTestId("editor-status")).toContainText("Viewing", { timeout: 15_000 }); // first Monaco load can be slow
  await page.locator(".monaco-editor .view-line").first().click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  await page.keyboard.type(text);
}

const dialog = (page: Page) => page.getByRole("dialog", { name: /Commit to/ });
async function openDialog(page: Page) {
  await page.getByRole("button", { name: "Commit…" }).click();
  await expect(dialog(page).getByText(/Your changes/)).toBeVisible();
}
const repo = async () => (await mock.room(ROOM)).repo;
const lastCommit = async () => {
  const [author, subject, ...files] = (await (await repo()).run(["show", "--name-only", "--format=%an%n%s", "HEAD"])).trim().split("\n").filter(Boolean);
  return { author, subject, files };
};

test("each person sees only their own changes; a commit contains only the committer's files", async ({ browser }) => {
  mock = await startMock({ port: 0 });
  const alice = await joinAs(browser, "alice");
  const bob = await joinAs(browser, "bob");
  await editFile(alice, "src/auth.ts", "// alice was here\n");
  await editFile(bob, "src/db.ts", "// bob was here\n");
  await expect(alice.getByTestId("editor-status")).toContainText("saved");
  await expect(bob.getByTestId("editor-status")).toContainText("saved");

  await openDialog(alice);
  const d = dialog(alice);
  await expect(d.getByText("Your changes · 1 file")).toBeVisible();
  await expect(d.getByRole("checkbox", { name: /src\/auth\.ts/ })).toBeChecked();
  await expect(d.getByRole("checkbox", { name: /src\/db\.ts/ })).toHaveCount(0);
  await expect(d.locator('[data-path="src/db.ts"]')).toContainText("bob’s work");

  await d.getByLabel("Commit message").fill("Alice fixes auth");
  await d.getByRole("button", { name: "Commit 1 file" }).click();
  await expect(d.getByText(/^Committed [0-9a-f]{7}\.$/)).toBeVisible();
  expect(await lastCommit()).toEqual({ author: "alice", subject: "Alice fixes auth", files: ["src/auth.ts"] });
  await expect(d.getByText("Your changes · 0 files")).toBeVisible();

  // Bob's work is still uncommitted and still his.
  await openDialog(bob);
  await expect(dialog(bob).getByRole("checkbox", { name: /src\/db\.ts/ })).toBeChecked();
  expect((await (await repo()).status()).map((e) => e.path)).toEqual(["src/db.ts"]);
});

test("the last keystrokes before committing are in the commit", async ({ browser }) => {
  mock = await startMock({ port: 0 });
  const alice = await joinAs(browser, "alice");
  await editFile(alice, "src/auth.ts", "// typed right before committing!\n");
  await openDialog(alice); // no wait for "saved"
  await dialog(alice).getByLabel("Commit message").fill("Quick commit");
  await dialog(alice).getByRole("button", { name: "Commit 1 file" }).click();
  await expect(dialog(alice).getByText(/^Committed/)).toBeVisible();
  const committed = await (await repo()).run(["show", "HEAD:src/auth.ts"]);
  expect(committed.startsWith("// typed right before committing!\n")).toBe(true);
});

test("commit and push lands on the remote", async ({ browser }) => {
  mock = await startMock({ port: 0 });
  const alice = await joinAs(browser, "alice");
  await editFile(alice, "src/auth.ts", "// shipped\n");
  await openDialog(alice);
  await dialog(alice).getByLabel("Commit message").fill("Ship it");
  await dialog(alice).getByRole("button", { name: "Commit and push" }).click();
  await expect(dialog(alice).getByText(/and pushed to the remote\./)).toBeVisible();
  const remote = new GitRepo((await mock.room(ROOM)).remoteDir);
  expect((await remote.run(["log", "-1", "--format=%an %s", "main"])).trim()).toBe("alice Ship it");
});

test("a push is held when remote changes touch someone else's uncommitted work", async ({ browser }) => {
  mock = await startMock({ port: 0 });
  const alice = await joinAs(browser, "alice");
  const bob = await joinAs(browser, "bob");
  await editFile(bob, "src/db.ts", "// bob's work in progress\n");
  await expect(bob.getByTestId("editor-status")).toContainText("saved");

  // A teammate outside the workspace pushes a change to the same file.
  const cloneDir = await mkdtemp(join(tmpdir(), "pineagent-e2e-clone-"));
  const clone = new GitRepo(cloneDir);
  await clone.run(["clone", "-q", (await mock.room(ROOM)).remoteDir, "."]);
  await writeFile(join(cloneDir, "src/db.ts"), "// remote version\n");
  await clone.run(["commit", "-qam", "remote db", "--author", "Teammate <t@example.com>"]);
  await clone.run(["push", "-q", "origin", "main"]);

  await editFile(alice, "src/auth.ts", "// alice\n");
  await openDialog(alice);
  await dialog(alice).getByLabel("Commit message").fill("Alice's change");
  await dialog(alice).getByRole("button", { name: "Commit and push" }).click();
  const problem = dialog(alice).getByRole("alert");
  await expect(problem).toContainText("Remote changes touch files with uncommitted work: src/db.ts");
  await expect(problem).toContainText("Your commit is saved");
  expect((await lastCommit()).author).toBe("alice");
  await expect(dialog(alice).getByRole("button", { name: "Push 1 commit" })).toBeVisible();
});
