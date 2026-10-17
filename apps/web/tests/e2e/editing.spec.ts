import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { startMock, type MockOptions } from "../../mock/server";

// Contract acceptance tests L1, L2, L4, F1, F3, F4 (SOCKET_LOCKS_AND_FILES.md) with two real
// browsers. Each test runs its own mock so lease timings can be shortened.
// L3 and F2 need raw socket access / dropped broadcasts and are covered by the unit tests.

process.env.MOCK_AVATARS = "0";
const PATH = "src/auth.ts";
const ROOM = "ws:demo:main";
const FAST_LEASES: MockOptions = { heartbeatMs: 500, leaseMs: 2000, sweepMs: 200 };

type Mock = Awaited<ReturnType<typeof startMock>>;
let mock: Mock;
let contexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
  await mock?.close();
});

const status = (p: Page) => p.getByTestId("editor-status");
// null until Monaco has mounted (e.g. right after a reload), so polls retry instead of throwing.
const editorText = (p: Page) => p.evaluate(() => (window as unknown as { __editorText?: () => string }).__editorText?.() ?? null);
const diskText = async () => readFile(join((await mock.workspace(ROOM)).root, PATH), "utf8");

async function openAs(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`/?as=${name}&api=http://localhost:${mock.port}`);
  await page.locator(`[data-path="${PATH}"]`).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("currentUser", { timeout: 15_000 }); // first Monaco load can be slow
  await expect(status(page)).toContainText("Viewing");
  return page;
}

// Puts the caret at the very start of the file.
async function focusStart(page: Page) {
  await page.locator(".monaco-editor .view-line").first().click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
}

test("L1: the first keystroke takes the lock; the other person sees a badge and a read-only editor", async ({ browser }) => {
  mock = await startMock({ port: 0 });
  const alice = await openAs(browser, "alice");
  const bob = await openAs(browser, "bob");

  await focusStart(alice);
  await alice.keyboard.type("hello ");
  await expect(status(alice)).toContainText("Writing");

  await expect(status(bob)).toContainText("Read-only · alice is editing", { timeout: 1000 });
  await expect(bob.locator(`[data-path="${PATH}"]`).getByTestId("lock-badge")).toContainText("alice");
  await expect.poll(() => editorText(bob)).toBe(await editorText(alice));

  // Bob's keystrokes do nothing.
  await focusStart(bob);
  await bob.keyboard.type("nope");
  expect(await editorText(bob)).not.toContain("nope");
});

test("L2: two people typing at once — exactly one becomes the writer, the other reverts", async ({ browser }) => {
  mock = await startMock({ port: 0 });
  const alice = await openAs(browser, "alice");
  const bob = await openAs(browser, "bob");
  await Promise.all([focusStart(alice), focusStart(bob)]);
  await Promise.all([alice.keyboard.type("AAAA"), bob.keyboard.type("BBBB")]);

  await expect.poll(async () => [await status(alice).textContent(), await status(bob).textContent()].join("|")).toMatch(
    /Writing.*\|.*Read-only|Read-only.*\|.*Writing/,
  );
  const writer = (await status(alice).textContent())!.includes("Writing") ? alice : bob;
  const viewer = writer === alice ? bob : alice;
  await expect.poll(() => diskText()).toMatch(writer === alice ? /^AAAA/ : /^BBBB/);
  await expect.poll(() => editorText(viewer)).toBe(await diskText());
  await expect.poll(() => editorText(writer)).toBe(await diskText());
});

test("F1: continuous typing — the viewer and the disk match the writer byte for byte", async ({ browser }) => {
  mock = await startMock({ port: 0 });
  const alice = await openAs(browser, "alice");
  const bob = await openAs(browser, "bob");
  await focusStart(alice);
  const line = "the quick brown fox jumps over the lazy dog ";
  for (let i = 0; i < 4; i++) await alice.keyboard.type(line, { delay: 15 });
  await alice.keyboard.press("Enter");

  await expect(status(alice)).toContainText("saved");
  const written = await editorText(alice);
  expect(written?.startsWith(line.repeat(4))).toBe(true);
  await expect.poll(() => editorText(bob)).toBe(written);
  await expect.poll(() => diskText()).toBe(written);
});

test("Release lock hands the file back; the other person can then edit", async ({ browser }) => {
  mock = await startMock({ port: 0 });
  const alice = await openAs(browser, "alice");
  const bob = await openAs(browser, "bob");
  await focusStart(alice);
  await alice.keyboard.type("x");
  await expect(status(bob)).toContainText("Read-only");
  await alice.getByRole("button", { name: "Release lock" }).click();
  await expect(status(bob)).toContainText("Viewing");
  await focusStart(bob);
  await bob.keyboard.type("y");
  await expect(status(bob)).toContainText("Writing");
  await expect(status(alice)).toContainText("Read-only · bob is editing");
});

test("F3: a viewer who reloads mid-edit rejoins and catches up", async ({ browser }) => {
  mock = await startMock({ port: 0 });
  const alice = await openAs(browser, "alice");
  const bob = await openAs(browser, "bob");
  await focusStart(alice);
  await alice.keyboard.type("before reload ");
  await bob.reload();
  await alice.keyboard.type("during reload ");
  await bob.locator(`[data-path="${PATH}"]`).click();
  await alice.keyboard.type("after reload ");
  await expect(status(alice)).toContainText("saved");
  await expect.poll(() => editorText(bob)).toBe(await editorText(alice));
});

test("L4: a writer who goes silent loses the lock after the lease; the other person can edit", async ({ browser }) => {
  mock = await startMock({ port: 0, ...FAST_LEASES });
  const alice = await openAs(browser, "alice");
  const bob = await openAs(browser, "bob");
  await focusStart(alice);
  await alice.keyboard.type("held ");
  await expect(status(bob)).toContainText("Read-only");

  await alice.context().setOffline(true); // no more heartbeats
  await expect(status(bob)).toContainText("Viewing", { timeout: 6000 });
  await expect(bob.locator(`[data-path="${PATH}"]`).getByTestId("lock-badge")).toHaveCount(0);
  await focusStart(bob);
  await bob.keyboard.type("mine now ");
  await expect(status(bob)).toContainText("Writing");
});

test("F4: edits made offline past the lease are kept for copying, and the editor shows the saved text", async ({ browser }) => {
  mock = await startMock({ port: 0, ...FAST_LEASES });
  const alice = await openAs(browser, "alice");
  await focusStart(alice);
  await alice.keyboard.type("saved ");
  await expect(status(alice)).toContainText("saved");

  await alice.context().setOffline(true);
  await alice.keyboard.type("unsaved ");
  const local = await editorText(alice);
  await alice.waitForTimeout(3500); // lease (2 s) runs out on the server
  await alice.context().setOffline(false);

  const banner = alice.getByRole("alert").filter({ hasText: "were not saved" });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => editorText(alice)).toBe(await diskText());
  expect(await diskText()).not.toContain("unsaved");

  await banner.getByRole("button", { name: "Copy my version" }).click();
  await expect(banner.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await alice.evaluate(() => navigator.clipboard.readText())).toBe(local);
});
