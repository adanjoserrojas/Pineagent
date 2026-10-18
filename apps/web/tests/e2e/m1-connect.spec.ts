import { expect, test } from "@playwright/test";
import { home } from "./rooms";
import { startMock } from "../../mock/server";

process.env.MOCK_AVATARS = "0"; // the in-process mock below; keeps the run off github.com

test("dev sign-in connects, joins the room and lists the tree", async ({ page }) => {
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");
  await expect(page.getByRole("tree", { name: "Files" }).locator('[data-path="src/"]')).toBeVisible();
  await expect(page.getByRole("list", { name: "People in this branch" }).getByRole("listitem")).toHaveCount(1);
});

test("a second user appears and disappears in presence", async ({ page, browser }) => {
  await page.goto(home("alice"));
  await expect(page.getByTestId("connection")).toHaveText("Connected");

  const bob = await (await browser.newContext()).newPage();
  await bob.goto(home("bob"));
  await expect(bob.getByTestId("connection")).toHaveText("Connected");

  const people = page.getByRole("list", { name: "People in this branch" }).getByRole("listitem");
  await expect(people).toHaveCount(2);
  await bob.context().close();
  await expect(people).toHaveCount(1);
});

test("losing the server shows reconnecting, then recovers", async ({ page }) => {
  // A private mock instance so stopping it doesn't affect the shared one.
  let mock = await startMock({ port: 0 });
  const port = mock.port;
  await page.goto(`/?as=alice&api=http://localhost:${port}`);
  const pill = page.getByTestId("connection");
  await expect(pill).toHaveText("Connected");

  await mock.close();
  await expect(pill).toHaveText("Reconnecting…");

  mock = await startMock({ port });
  await expect(pill).toHaveText("Connected", { timeout: 15_000 });
  await mock.close();
});
