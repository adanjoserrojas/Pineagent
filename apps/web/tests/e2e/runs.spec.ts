import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { openFile } from "./rooms";
import { startMock, type MockOptions } from "../../mock/server";

// The run panel and the plant against the mock harness (contracts/RUN_EVENTS.md).
// Release scenarios 2 (plant shows planning/routing/executing/approval/error/done) and 3 (fallback).

process.env.MOCK_AVATARS = "0";
type Mock = Awaited<ReturnType<typeof startMock>>;
let mock: Mock;
let contexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  contexts = [];
  await mock?.close();
});

async function joinAs(browser: Browser, name: string, opts: MockOptions = {}): Promise<Page> {
  mock ??= await startMock({ port: 0, runStepMs: 150, ...opts });
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`/?as=${name}&api=http://localhost:${mock.port}`);
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  // Record every face sent to the plant, through the same plug point the Web Serial bridge uses.
  await page.evaluate(() => {
    const w = window as unknown as { __faces: string[]; __plant: { attach(s: { show(f: string): void }): void } };
    w.__faces = [];
    w.__plant.attach({ show: (f) => w.__faces.push(f) });
  });
  return page;
}

const faces = (p: Page) => p.evaluate(() => (window as unknown as { __faces: string[] }).__faces);
const card = (p: Page) => p.getByRole("list", { name: "Runs" }).locator("article").first();

async function startRun(p: Page, task: string) {
  await p.getByLabel("Ask your agent").fill(task);
  await p.getByRole("button", { name: "Start run" }).click();
  await expect(card(p)).toBeVisible();
}

test.beforeEach(() => {
  // A fresh mock per test (joinAs creates it lazily so tests can pass options).
  mock = undefined as unknown as Mock;
});

test("a run goes planning → routing → executing → done, and the plant follows", async ({ browser }) => {
  const alice = await joinAs(browser, "alice");
  await startRun(alice, "add a test for currentUser");
  await expect(card(alice).getByTestId("run-state")).toHaveText("done");
  await expect(card(alice).locator(".run-step-done")).toHaveCount(3);
  await expect(card(alice).getByTestId("router-mode")).toHaveText("router: OpenAI Decisions");

  const seen = await faces(alice);
  const order = ["planning", "routing", "executing", "done"].map((f) => seen.indexOf(f));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // "done" smiles for a few seconds, then the plant returns to idle. (The recorder also got the
  // initial "idle" when it attached, so check the latest face, not membership.)
  await expect.poll(async () => (await faces(alice)).at(-1), { timeout: 8000 }).toBe("idle");
  expect((await faces(alice)).lastIndexOf("idle")).toBeGreaterThan(seen.indexOf("done"));
});

test("the agent locks its file: the owner's editor is read-only until it finishes, and the edit is theirs to commit", async ({ browser }) => {
  const alice = await joinAs(browser, "alice", { runStepMs: 400 });
  await openFile(alice, "src/auth.ts");
  await expect(alice.getByTestId("editor-status")).toContainText("Viewing");
  await startRun(alice, "tidy auth.ts");

  await expect(alice.getByText("Your agent is editing this file.")).toBeVisible();
  await expect(alice.locator('[data-path="src/auth.ts"]').getByTestId("lock-badge")).toContainText("Your agent");
  await expect(alice.getByTestId("editor-status")).toContainText("Read-only · Your agent is editing");

  await expect(card(alice).getByTestId("run-state")).toHaveText("done", { timeout: 15_000 });
  await expect(alice.getByTestId("editor-status")).toContainText("Viewing");
  await expect.poll(() => alice.evaluate(() => (window as unknown as { __editorText?: () => string }).__editorText?.() ?? "")).toMatch(
    /^\/\/ alice's agent: tidy auth\.ts\n/,
  );

  await alice.getByRole("button", { name: "Commit…" }).click();
  await expect(alice.getByRole("dialog").getByRole("checkbox", { name: /src\/auth\.ts/ })).toBeChecked();
});

test("low confidence asks the owner to choose; a teammate sees it read-only", async ({ browser }) => {
  const alice = await joinAs(browser, "alice");
  const bob = await joinAs(browser, "bob");
  await startRun(alice, "unsure how to fix auth");

  await expect(card(alice).getByTestId("run-state")).toHaveText("needs a choice");
  await expect.poll(() => faces(alice)).toContain("awaiting_approval");
  await expect(card(bob)).toContainText("Waiting for alice to choose a plan.");
  await expect(card(bob).getByRole("button", { name: "Run this plan" })).toHaveCount(0);

  await card(alice).getByRole("radio", { name: /41%/ }).check();
  await card(alice).getByRole("button", { name: "Run this plan" }).click();
  await expect(card(alice).getByTestId("run-state")).toHaveText("done");
  await expect(card(alice).locator(".run-steps")).toContainText("grep");
  await expect(card(bob).getByTestId("run-state")).toHaveText("done");
});

test("when the scorer is down the run falls back to the LLM, with a badge and the fallback face", async ({ browser }) => {
  const alice = await joinAs(browser, "alice");
  await startRun(alice, "fallback: rename a variable");
  await expect(card(alice).getByTestId("router-mode")).toHaveText("router: LLM fallback");
  await expect(card(alice).getByTestId("run-state")).toHaveText("done");
  expect(await faces(alice)).toContain("routing_llm");
});

test("Jev failover and warm coding recovery show as separate badges", async ({ browser }) => {
  const alice = await joinAs(browser, "alice");
  await startRun(alice, "backup: tidy db.ts");
  await expect(card(alice).getByTestId("run-state")).toHaveText("done");
  await expect(card(alice).getByTestId("router-mode")).toHaveText("router: Jev (backup scorer)");
  await expect(card(alice).getByTestId("coding-recovery")).toHaveCount(0);

  await startRun(alice, "recover: tidy auth.ts");
  await expect(card(alice).getByTestId("run-state")).toHaveText("done");
  await expect(card(alice).getByTestId("router-mode")).toHaveText("router: OpenAI Decisions");
  await expect(card(alice).getByTestId("coding-recovery")).toHaveText("coding recovery: warm agent");
});

test("a failing step shows the error on the card and the plant", async ({ browser }) => {
  const alice = await joinAs(browser, "alice");
  await startRun(alice, "this will fail");
  await expect(card(alice).getByTestId("run-state")).toHaveText("failed");
  await expect(card(alice).getByRole("alert")).toContainText("Failed at step 2");
  await expect.poll(() => faces(alice)).toContain("error");
  await expect(alice.locator(".plant")).toHaveAttribute("data-face", "error");
});

test("Pause agent from the editor gives the file back; Resume finishes the run", async ({ browser }) => {
  const alice = await joinAs(browser, "alice", { runStepMs: 500 });
  await openFile(alice, "src/auth.ts");
  await expect(alice.getByTestId("editor-status")).toContainText("Viewing");
  await startRun(alice, "slow change to auth.ts");
  await expect(alice.getByRole("button", { name: "Pause agent" })).toBeVisible();
  await alice.getByRole("button", { name: "Pause agent" }).click();

  await expect(card(alice).getByTestId("run-state")).toHaveText("paused");
  await expect(alice.getByTestId("editor-status")).toContainText("Viewing");
  await expect.poll(() => faces(alice)).toContain("paused");

  await card(alice).getByRole("button", { name: "Resume" }).click();
  await expect(card(alice).getByTestId("run-state")).toHaveText("done", { timeout: 15_000 });
});

test("reloading the page restores the runs and the plant's state", async ({ browser }) => {
  const alice = await joinAs(browser, "alice");
  await startRun(alice, "unsure about this");
  await expect(card(alice).getByTestId("run-state")).toHaveText("needs a choice");
  await alice.reload();
  await expect(card(alice).getByTestId("run-state")).toHaveText("needs a choice");
  await expect(alice.locator(".plant")).toHaveAttribute("data-face", "awaiting_approval");
});
