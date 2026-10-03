import { test, expect } from "@playwright/test";
import { player, week, mockDashboard } from "./fixtures.js";

test("latest week is the default, query selection is honored, and changing weeks updates the URL", async ({ page }) => {
    await mockDashboard(page, {
        "/data/available-weeks.json": { "2026": [1, 2] },
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
});

for (const entry of [
    { name: "empty manifest", responses: { "/data/available-weeks.json": { "2026": [] } },
        message: "No weeks are available yet." },
    { name: "missing manifest", responses: { "/data/available-weeks.json": null },
        message: "Available weeks could not be loaded." },
    { name: "missing week", responses: { "/data/2026/week01.json": null },
        message: "Week 1 is not available yet." },
]) {
    test(`${entry.name} shows a useful loading message`, async ({ page }) => {
        await mockDashboard(page, entry.responses);
        await page.goto("/");
        await expect(page.locator("#weekly-message")).toHaveText(entry.message);
        await expect(page.locator("#player-list .player-card")).toHaveCount(0);
    });
}

test("announcements preserve line breaks and display text without interpreting HTML", async ({ page }) => {
    await mockDashboard(page, { "/assets/announcement-top.txt": "  Hello\n<strong>Pool</strong>  " });
    await page.goto("/");
    await expect(page.locator("#announcement-top")).toHaveText("Hello\n<strong>Pool</strong>");
    await expect(page.locator("#announcement-top")).toBeVisible();
    await expect(page.locator("#announcement-top strong")).toHaveCount(0);
    await expect(page.locator("#announcement-bottom")).toBeHidden();
});

test("failed announcements remain hidden without blocking the dashboard", async ({ page }) => {
    await mockDashboard(page, { "/assets/announcement-top.txt": null });
    await page.route("**/assets/announcement-bottom.txt", (route) => route.abort());
    await page.goto("/");
    await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
    await expect(page.locator("#announcement-top")).toBeHidden();
    await expect(page.locator("#announcement-bottom")).toBeHidden();
});

test("refresh updates changed data, preserves unchanged cards, and retains data on failure", async ({ page }) => {
    await page.clock.install();
    let current = week();
    await mockDashboard(page, { "/data/2026/week01.json": () => current });
    await page.goto("/");
    await expect(page.locator("#player-list .player-name")).toHaveText("alex");
    await page.locator("#player-list .player-card").evaluate((card) => { card.dataset.testMarker = "original"; });
    const refresh = async () => {
        const response = page.waitForResponse((r) => r.url().endsWith("/week01.json"));
        await page.clock.runFor(60_000);
        await response;
    };
    await refresh();
    await expect(page.locator("#player-list .player-card")).toHaveAttribute("data-test-marker", "original");
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
    await mockDashboard(page, { "/data/2026/week01.json": () => { requests += 1; return current; } });
    await page.goto("/");
    await page.getByRole("button", { name: /alex/ }).click();
    current = week({ players: [player("beth")] });
    await page.clock.runFor(60_000);
    expect(requests).toBe(1);
    await expect(page.locator(".player-card-overlay .player-name")).toHaveText("alex");
    await page.keyboard.press("Escape");
    const response = page.waitForResponse((r) => r.url().endsWith("/week01.json"));
    await page.clock.runFor(60_000);
    await response;
    await expect(page.locator("#player-list .player-name")).toHaveText("beth");
});
