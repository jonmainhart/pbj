import { test, expect } from "@playwright/test";
import { player, week, mockDashboard, trackWeekProcessing } from "./fixtures.js";

test(
  "latest week is the default, query selection is honored, and changing weeks updates the URL",
  { tag: "@smoke" },
  async ({ page }) => {
    await mockDashboard(page, {
      "/data/available-weeks.json": { 2026: [1, 2] },
      "/data/2026/week02.json": week({ week: 2, players: [player("beth")] }),
    });
    await page.goto("/?week=99");
    await expect(page.locator("#week-status")).toHaveText("Week 2 In Progress");
    await expect(page).toHaveURL(/\?week=2$/);
    await page.getByRole("combobox", { name: "Week" }).selectOption("1");
    await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
    await expect(page.locator("#player-list .player-name")).toHaveText("alex");
    await expect(page).toHaveURL(/\?week=1$/);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Week" })).toHaveValue("1");
  },
);

for (const entry of [
  {
    name: "empty manifest",
    responses: { "/data/available-weeks.json": { 2026: [] } },
    message: "No weeks are available yet.",
  },
  {
    name: "missing manifest",
    responses: { "/data/available-weeks.json": null },
    message: "Available weeks could not be loaded.",
  },
  {
    name: "missing week",
    responses: { "/data/2026/week01.json": null },
    message: "Week 1 is not available yet.",
  },
]) {
  test(`${entry.name} shows a useful loading message`, async ({ page }) => {
    await mockDashboard(page, entry.responses);
    await page.goto("/");
    await expect(page.locator("#weekly-message")).toHaveText(entry.message);
    await expect(page.locator("#player-list .player-card")).toHaveCount(0);
  });
}

test("announcements preserve line breaks and display text without interpreting HTML", async ({
  page,
}) => {
  await mockDashboard(page, {
    "/data/announcements.json": {
      top: { text: "  Hello\n<strong>Pool</strong>  ", link: null },
    },
  });
  await page.goto("/");
  await expect(page.locator("#announcement-top")).toHaveText(
    "Hello\n<strong>Pool</strong>",
  );
  await expect(page.locator("#announcement-top")).toBeVisible();
  await expect(page.locator("#announcement-top strong")).toHaveCount(0);
  await expect(page.locator("#announcement-bottom")).toBeHidden();
});

test("failed announcements remain hidden without blocking the dashboard", async ({
  page,
}) => {
  await mockDashboard(page, { "/data/announcements.json": null });
  await page.goto("/");
  await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
  await expect(page.locator("#announcement-top")).toBeHidden();
  await expect(page.locator("#announcement-bottom")).toBeHidden();
});

test("refresh updates changed data, preserves unchanged cards, and retains data on failure", async ({
  page,
}) => {
  await page.clock.install();
  const processed = await trackWeekProcessing(page);
  let current = week();
  await mockDashboard(page, { "/data/2026/week01.json": () => current });
  await page.goto("/");
  await expect(page.locator("#player-list .player-name")).toHaveText("alex");
  await page.locator("#player-list .player-card").evaluate((card) => {
    card.dataset.testMarker = "original";
  });
  await processed(1);
  let completed = 1;
  const refresh = async () => {
    await page.clock.runFor(60_000);
    await processed(++completed);
  };
  await refresh();
  await expect(page.locator("#player-list .player-card")).toHaveAttribute(
    "data-test-marker",
    "original",
  );
  current = week({ players: [player("beth")] });
  await refresh();
  await expect(page.locator("#player-list .player-name")).toHaveText("beth");
  current = null;
  await refresh();
  await expect(page.locator("#player-list .player-name")).toHaveText("beth");
  await expect(page.locator("#weekly-message")).toBeEmpty();
});

test("refresh is suspended while a player card is open", async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  let current = week();
  await mockDashboard(page, {
    "/data/2026/week01.json": () => {
      requests += 1;
      return current;
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /alex/ }).click();
  current = week({ players: [player("beth")] });
  await page.clock.runFor(60_000);
  expect(requests).toBe(1);
  await expect(page.locator(".player-card-overlay .player-name")).toHaveText(
    "alex",
  );
  await page.keyboard.press("Escape");
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/week01.json"),
  );
  await page.clock.runFor(60_000);
  await response;
  await expect(page.locator("#player-list .player-name")).toHaveText("beth");
});

test("one announcement request renders safe links at both positions and refreshes on resume", async ({
  page,
}) => {
  let requests = 0;
  let current = {
    top: {
      text: "Top",
      link: { label: "Schedule", url: "https://example.com/week" },
    },
    bottom: {
      text: "Bottom",
      link: { label: "Unsafe", url: "javascript:alert(1)" },
    },
  };
  await mockDashboard(page, {
    "/data/announcements.json": () => {
      requests++;
      return current;
    },
  });
  await page.goto("/");
  await expect(page.locator("#announcement-top a")).toHaveAttribute(
    "href",
    "https://example.com/week",
  );
  await expect(page.locator("#announcement-bottom")).toHaveText("Bottom");
  await expect(page.locator("#announcement-bottom a")).toHaveCount(0);
  expect(requests).toBe(1);
  current = {
    top: { text: "Changed", link: null },
    bottom: { text: "", link: null },
  };
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(page.locator("#announcement-top")).toHaveText("Changed");
  await expect(page.locator("#announcement-bottom")).toBeHidden();
  expect(requests).toBe(2);
});
for (const value of [
  null,
  {},
  { top: { text: 42 } },
  { top: { text: "" }, bottom: { text: "   " } },
]) {
  test(`malformed or empty announcements stay hidden: ${JSON.stringify(value)}`, async ({
    page,
  }) => {
    await mockDashboard(page, { "/data/announcements.json": value });
    await page.goto("/");
    await expect(page.locator("#announcement-top")).toBeHidden();
    await expect(page.locator("#announcement-bottom")).toBeHidden();
    await expect(page.locator("#week-status")).toBeVisible();
  });
}

for (const failure of ["network", "invalid JSON"]) {
  test(`announcement ${failure} failure does not block the dashboard`, async ({
    page,
  }) => {
    await mockDashboard(page);
    await page.route("**/data/announcements.json", (route) =>
      failure === "network"
        ? route.abort()
        : route.fulfill({ contentType: "application/json", body: "broken" }),
    );
    await page.goto("/");
    await expect(page.locator("#announcement-top")).toBeHidden();
    await expect(page.locator("#announcement-bottom")).toBeHidden();
    await expect(page.locator("#week-status")).toBeVisible();
  });
}

for (const initial of ["", "?week=7", "?week=9"]) {
  test(`publication discovers Week 10 and respects latest preference: ${initial || "default"}`, async ({ page }) => {
    await page.clock.install();
    const processed = await trackWeekProcessing(page);
    let weeks = [7, 9];
    await mockDashboard(page, {
      "/data/available-weeks.json": () => ({ 2026: weeks }),
      "/data/2026/week07.json": week({ week: 7 }),
      "/data/2026/week09.json": week({ week: 9 }),
      "/data/2026/week10.json": week({ week: 10 }),
      "/data/2026/week11.json": week({ week: 11 }),
    });
    await page.goto(`/${initial}`);
    const selected = initial === "?week=7" ? "7" : "9";
    await expect(page.locator("#week-select")).toHaveValue(selected);
    await processed(1);
    // The same option nodes must survive an unchanged manifest.
    await page.locator("#week-select option").first().evaluate((option) => {
      option.dataset.marker = "original";
    });
    await page.clock.runFor(60_000);
    await processed(2);
    await expect(page.locator("#week-select option").first()).toHaveAttribute("data-marker", "original");
    weeks = [10, 7, 9, 10];
    await page.clock.runFor(60_000);
    await processed(3);
    await expect(page.locator("#week-select option")).toHaveText(["7", "9", "10"]);
    const expected = selected === "7" ? "7" : "10";
    await expect(page.locator("#week-select")).toHaveValue(expected);
    await expect(page).toHaveURL(new RegExp(`week=${expected}$`));
    await expect(page.locator("#week-status")).toHaveText(`Week ${expected} In Progress`);
    if (selected === "7") {
      await page.locator("#week-select").selectOption("10");
      await processed(4);
    }
    weeks = [7, 9, 10, 11];
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.runFor(120_000);
    await expect(page.locator("#week-select option")).toHaveCount(3);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("#week-select")).toHaveValue("11");
    await expect(page.locator("#week-status")).toHaveText("Week 11 In Progress");
  });
}

test("publication failures preserve the display and open cards defer advancement", async ({ page }) => {
  await page.clock.install();
  const processed = await trackWeekProcessing(page);
  let manifest = { 2026: [9] };
  let published = null;
  await mockDashboard(page, {
    "/data/available-weeks.json": () => manifest,
    "/data/2026/week09.json": week({ week: 9 }),
    "/data/2026/week10.json": () => published,
  });
  await page.goto("/");
  await processed(1);
  let count = 1;
  for (const invalid of [null, {}, { 2026: [] }, { 2026: ["10"] }]) {
    manifest = invalid;
    await page.clock.runFor(60_000);
    await processed(++count);
  }
  manifest = { 2026: [9, 10] };
  await page.clock.runFor(60_000);
  await processed(count + 1);
  await expect(page.locator("#week-select")).toHaveValue("9");
  await expect(page.locator("#week-status")).toHaveText("Week 9 In Progress");
  await expect(page).toHaveURL(/week=9$/);
  published = week({ week: 10, players: [player("beth")] });
  await page.getByRole("button", { name: /alex/ }).click();
  await page.clock.runFor(60_000);
  await expect(page.locator(".player-card-overlay .player-name")).toHaveText("alex");
  await page.keyboard.press("Escape");
  await page.clock.runFor(60_000);
  await expect(page.locator("#week-select")).toHaveValue("10");
  await expect(page.locator("#player-list .player-name")).toHaveText("beth");
});

test("overlapping publication refreshes cannot overwrite manual navigation", async ({ page }) => {
  await page.clock.install();
  const processed = await trackWeekProcessing(page);
  let weeks = [7, 9];
  let manifests = 0;
  await mockDashboard(page, {
    "/data/available-weeks.json": () => {
      manifests++;
      return { 2026: weeks };
    },
    "/data/2026/week07.json": week({ week: 7 }),
    "/data/2026/week09.json": week({ week: 9 }),
  });
  await page.goto("/");
  await processed(1);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route("**/week10.json", async (route) => {
    await held;
    await route.fulfill({ json: week({ week: 10 }) });
  });
  weeks = [7, 9, 10];
  const requested = page.waitForRequest("**/week10.json");
  await page.clock.runFor(60_000);
  await requested;
  await page.clock.runFor(120_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(manifests).toBe(2);
  await page.locator("#week-select").selectOption("7");
  await processed(2);
  release();
  await processed(3);
  await expect(page.locator("#week-select")).toHaveValue("7");
  await expect(page.locator("#week-status")).toHaveText("Week 7 In Progress");
  await expect(page).toHaveURL(/week=7$/);
});

test("rapid manual week changes ignore an older successful response", async ({ page }) => {
  const processed = await trackWeekProcessing(page);
  await mockDashboard(page, {
    "/data/available-weeks.json": { 2026: [7, 9] },
    "/data/2026/week09.json": week({ week: 9 }),
  });
  await page.goto("/");
  await processed(1);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route("**/week07.json", async (route) => {
    await held;
    await route.fulfill({ json: week({ week: 7 }) });
  });
  const requested = page.waitForRequest("**/week07.json");
  await page.locator("#week-select").selectOption("7");
  await requested;
  await page.locator("#week-select").selectOption("9");
  await processed(2);
  release();
  await processed(3);
  await expect(page.locator("#week-status")).toHaveText("Week 9 In Progress");
  await expect(page).toHaveURL(/week=9$/);
});

test("a failed initial manifest recovers on resume and honors a historical deep link", async ({ page }) => {
  await page.clock.install();
  let manifest = null;
  await mockDashboard(page, {
    "/data/available-weeks.json": () => manifest,
    "/data/2026/week07.json": week({ week: 7 }),
    "/data/2026/week09.json": week({ week: 9 }),
  });
  await page.goto("/?week=7");
  await expect(page.locator("#weekly-message")).toHaveText("Available weeks could not be loaded.");
  manifest = { 2026: [7, 9] };
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#week-select")).toHaveValue("7");
  await expect(page.locator("#week-status")).toHaveText("Week 7 In Progress");
  await expect(page.locator("#weekly-message")).toBeEmpty();
});
