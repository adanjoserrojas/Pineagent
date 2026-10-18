import { expect, test, type Page } from "@playwright/test";

// Tests that share the default mock run in parallel, so each one gets its own workspace room
// (/ws/<test id>/main). Pages within one test share it.
export const home = (name: string) => `/ws/${test.info().testId}/main?as=${name}`;

// Open a file the way a user would without depending on which folders are expanded: filter by
// its full path and press Enter (opens the first match).
export async function openFile(page: Page, path: string) {
  const filter = page.getByRole("searchbox", { name: "Filter files" });
  await filter.fill(path);
  // The tree arrives after connecting; Enter on an empty result would open nothing.
  await expect(page.getByRole("tree", { name: "Files" }).locator(`[data-path="${path}"]`)).toBeVisible();
  await filter.press("Enter");
  await filter.fill("");
}

// Expand every folder above `path` in the explorer so its row is visible.
export async function expandTo(page: Page, path: string) {
  const parts = path.replace(/\/$/, "").split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = page.getByRole("tree", { name: "Files" }).locator(`[data-path="${parts.slice(0, i).join("/")}/"]`);
    if ((await dir.getAttribute("aria-expanded")) === "false") await dir.click();
  }
}
