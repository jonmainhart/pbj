import { test, expect } from "@playwright/test";
import { player, week, mockDashboard } from "./fixtures.js";

function seasonPlayer(id, overrides = {}) {
  return {
    player_id: id,
    weeks_played: 2,
    wins: 8,
    losses: 2,
    ties: 0,
    missed_picks: 0,
    accuracy: 0.8,
    weekly_wins: 0,
    last_place_finishes: 0,
    ...overrides,
  };
}

test(
  "season sorts by wins then Win %, uses competition ranks, and shows finish counts",
  { tag: "@smoke" },
  async ({ page }) => {
    await mockDashboard(page, {
      "/data/2026/week01.json": week({
        players: [player("alex", { nickname: "Ace" })],
      }),
      "/data/2026/week02.json": week({
        week: 2,
        players: [player("beth", { name: "Beth Example" })],
      }),
      "/data/2026/season.json": {
        season: 2026,
        weeks_scored: [1, 2],
        players: [
          seasonPlayer("unknown-player", { wins: 7, accuracy: 0.95 }),
          seasonPlayer("casey", { accuracy: 0.7 }),
          seasonPlayer("beth", { weekly_wins: 1 }),
          seasonPlayer("alex", { weekly_wins: 2, last_place_finishes: 1 }),
        ],
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: /alex|Ace/ }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "🏆 Season" }).click();
    await expect(page.locator("#weekly-view")).toBeHidden();
    await expect(page.locator("#season-view")).toBeVisible();
    await expect(page.locator("#season-tab")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#season-message")).toHaveText(
      "2 completed week(s).",
    );
    await expect(page.locator(".season-name")).toHaveText([
      "👑 1. Beth Example",
      "👑 1. Ace",
      "3. Casey",
      "4. Unknown Player",
    ]);
    await expect(page.locator(".weekly-wins")).toHaveText([
      "🏆 1",
      "🏆 2 • 💩 1",
      "🏆 0",
      "🏆 0",
    ]);
    await expect(page.locator(".season-accuracy")).toHaveText([
      "Win % 80",
      "Win % 80",
      "Win % 70",
      "Win % 95",
    ]);
    await page.getByRole("button", { name: "🏈 Weekly" }).click();
    await expect(page.locator("#weekly-view")).toBeVisible();
    await expect(page.locator("#season-view")).toBeHidden();
    await expect(page.locator("#weekly-tab")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  },
);

test("empty season shows an explanation", async ({ page }) => {
  await mockDashboard(page);
  await page.goto("/");
  await page.getByRole("button", { name: "🏆 Season" }).click();
  await expect(page.locator("#season-message")).toHaveText(
    "No completed weeks yet.",
  );
  await expect(page.locator(".season-card")).toHaveCount(0);
});

test("missing season shows an error and the weekly view remains usable", async ({
  page,
}) => {
  await mockDashboard(page, { "/data/2026/season.json": null });
  await page.goto("/");
  await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
  await page.getByRole("button", { name: "🏆 Season" }).click();
  await expect(page.locator("#season-message")).toHaveText(
    "Season standings are not available yet.",
  );
  await page.getByRole("button", { name: "🏈 Weekly" }).click();
  await expect(page.locator("#player-list .player-name")).toHaveText("alex");
});

test("season name loading failures fall back to humanized IDs", async ({
  page,
}) => {
  await mockDashboard(page, {
    "/data/2026/season.json": {
      season: 2026,
      weeks_scored: [2],
      players: [seasonPlayer("unknown-player")],
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "🏆 Season" }).click();
  await expect(page.locator(".season-name")).toHaveText("👑 1. Unknown Player");
});

for (const historical of [false, true]) {
  test(`season requests only unresolved names (${historical ? "historical participant" : "current roster"})`, async ({
    page,
  }) => {
    const requests = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/data\/2026\/.*json$/.test(path)) requests.push(path);
    });
    await mockDashboard(page, {
      "/data/available-weeks.json": { 2026: [1, 2, 3, 4] },
      "/data/2026/week04.json": week({
        week: 4,
        players: [player("alice", { name: "Current Alice" })],
      }),
      "/data/2026/week03.json": week({
        week: 3,
        players: [
          player("retired", { name: "Historical Player" }),
          player("alice", { name: "Old Alice" }),
        ],
      }),
      "/data/2026/season.json": {
        season: 2026,
        weeks_scored: [1, 2, 3, 4],
        players: [
          seasonPlayer("alice"),
          ...(historical ? [seasonPlayer("retired")] : []),
        ],
      },
    });
    await page.goto("/");
    await expect(page.locator("#week-status")).toHaveText("Week 4 In Progress");
    expect(requests).toEqual(["/data/2026/week04.json"]);
    await page.locator("#season-tab").click();
    await expect(page.locator(".season-name")).toContainText(
      historical ? ["Current Alice", "Historical Player"] : ["Current Alice"],
    );
    expect(requests).toEqual([
      "/data/2026/week04.json",
      "/data/2026/season.json",
      ...(historical ? ["/data/2026/week03.json"] : []),
    ]);
    await page.locator("#weekly-tab").click();
    await page.locator("#season-tab").click();
    expect(requests).toHaveLength(historical ? 3 : 2);
    await page.locator("#weekly-tab").click();
    await page.locator("#week-select").selectOption("3");
    await expect(page.locator("#week-status")).toHaveText("Week 3 In Progress");
    await page.locator("#season-tab").click();
    await expect(page.locator(".season-name").first()).toContainText(
      "Current Alice",
    );
    expect(
      requests.filter((path) => path.endsWith("season.json")),
    ).toHaveLength(1);
  });
}

test("embedded season names render with only the season request after initialization", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/data\/2026\/.*json$/.test(path)) requests.push(path);
  });
  await mockDashboard(page, {
    "/data/available-weeks.json": { 2026: [1, 2, 3] },
    "/data/2026/week03.json": week({
      week: 3,
      players: [player("alice", { name: "Future Alice" })],
    }),
    "/data/2026/season.json": {
      season: 2026,
      weeks_scored: [1, 2],
      players: [
        seasonPlayer("alice", { display_name: "Completed Nickname", weekly_wins: 1 }),
        seasonPlayer("retired", { display_name: "Historical Participant", wins: 7 }),
      ],
    },
  });
  await page.goto("/");
  await expect(page.locator("#week-status")).toHaveText("Week 3 In Progress");
  expect(requests).toEqual(["/data/2026/week03.json"]);
  await page.locator("#season-tab").click();
  await expect(page.locator(".season-name")).toContainText([
    "Completed Nickname", "Historical Participant",
  ]);
  await expect(page.locator(".season-record")).toHaveText(["8-2-0", "7-2-0"]);
  expect(requests).toEqual(["/data/2026/week03.json", "/data/2026/season.json"]);
});
