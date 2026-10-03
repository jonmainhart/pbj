import { test, expect } from "@playwright/test";

test("weekly dashboard loads and a player card opens and closes", async ({ page }) => {
    const week = {
        season: 2026,
        week: 1,
        lock_time: "2026-09-13T16:00:00Z",
        games: [{
            id: "smoke-game",
            scheduled_time: "2026-09-13T17:00:00Z",
            away: { id: "buf", abbreviation: "BUF", name: "Buffalo Bills" },
            home: { id: "mia", abbreviation: "MIA", name: "Miami Dolphins" },
            status: "scheduled",
            away_score: null,
            home_score: null,
        }],
        players: [{
            id: "alex-example",
            name: "Alex Example",
            nickname: null,
            picks: { "smoke-game": "BUF" },
            tiebreaker: 42,
        }],
        results: null,
    };

    // Keep the smoke test independent of production pool data and announcements.
    await page.route("**/data/**", async (route) => {
        const path = new URL(route.request().url()).pathname;

        if (path === "/data/available-weeks.json") {
            await route.fulfill({ json: { "2026": [1] } });
        } else if (path === "/data/2026/week01.json") {
            await route.fulfill({ json: week });
        } else {
            await route.fulfill({ status: 404 });
        }
    });
    await page.route("**/assets/announcement-*.txt", (route) =>
        route.fulfill({ contentType: "text/plain", body: "" }),
    );

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "PBJ Football" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Week 1", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Week", exact: true })).toHaveValue("1");
    await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
    await expect(page.locator("#weekly-message")).toBeEmpty();
    await expect(page.locator("#season-view")).toBeHidden();

    const player = page.locator("#player-list").getByRole("button", {
        name: /Alex Example/,
    });
    await expect(player).toHaveAttribute("aria-expanded", "false");
    await player.click();

    const overlay = page.locator(".player-card-overlay");
    const expandedPlayer = overlay.getByRole("button", { name: /Alex Example/ });
    await expect(overlay).toBeVisible();
    await expect(expandedPlayer).toHaveAttribute("aria-expanded", "true");
    await expect(expandedPlayer).toBeFocused();
    await expect(overlay.locator(".game-name")).toContainText("BUF @ MIA");
    await expect(overlay.locator(".pick-team")).toHaveText("BUF");
    await expect(overlay.locator(".pick-status")).toHaveText("⏳");

    await expandedPlayer.click();

    await expect(overlay).toHaveCount(0);
    await expect(player).toHaveAttribute("aria-expanded", "false");
    await expect(player).toBeFocused();
});
