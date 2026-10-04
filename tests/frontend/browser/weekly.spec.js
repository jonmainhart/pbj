import { test, expect } from "@playwright/test";
import { game, player, result, week, mockDashboard } from "./fixtures.js";

test("picks show pending, live, final, tied, and N/P outcomes", async ({ page }) => {
    const games = [
        game("pending"),
        game("ahead", { status: "live", away_score: 7, home_score: 0 }),
        game("behind", { status: "live", away_score: 0, home_score: 7 }),
        game("level", { status: "live", away_score: 0, home_score: 0 }),
        game("unavailable", { status: "live" }),
        game("correct", { status: "final", away_score: 7, home_score: 0 }),
        game("wrong", { status: "final", away_score: 0, home_score: 7 }),
        game("tie", { status: "final", away_score: 0, home_score: 0 }),
        game("missing-pending"),
        game("missing-final", { status: "final", away_score: 7, home_score: 0 }),
        game("missing-tie", { status: "final", away_score: 0, home_score: 0 }),
    ];
    const picks = Object.fromEntries(games.slice(0, 8).map((g) => [g.id, "BUF"]));
    await mockDashboard(page, { "/data/2026/week01.json": week({
        games, players: [player("alex", { picks })],
    }) });
    await page.goto("/");
    await page.getByRole("button", { name: /alex/ }).click();
    const rows = page.locator(".player-card-overlay .pick-row");
    await expect(rows).toHaveCount(games.length);
    await expect(rows.locator(".pick-status")).toHaveText([
        "⏳", "🟢", "🟡", "🟢", "🟢", "✅", "❌", "➖", "⏳", "❌", "❌",
    ]);
    await expect(rows.locator(".pick-team")).toHaveText([
        ...Array(8).fill("BUF"), "N/P", "N/P", "N/P",
    ]);
    await expect(rows.nth(1).locator(".game-name")).toHaveText("BUF 7 @ MIA 0 — Live");
    await expect(rows.nth(5).locator(".game-name")).toHaveText("BUF 7 @ MIA 0 — Final");
    const styles = ["pending", "live", "live-losing", "live", "live", "correct",
        "wrong", "tie", "pending", "wrong", "wrong"];
    for (const [index, style] of styles.entries()) {
        await expect(rows.nth(index).locator(".pick-value")).toHaveClass(`pick-value pick-${style}`);
    }
});

test("scheduled kickoff uses the browser's timezone", async ({ page }) => {
    await mockDashboard(page);
    await page.goto("/");
    await page.getByRole("button", { name: /alex/ }).click();
    const time = await page.evaluate(() => new Intl.DateTimeFormat(undefined, {
        weekday: "short", hour: "numeric", minute: "2-digit",
    }).format(new Date("2026-09-13T17:00:00Z")));
    await expect(page.locator(".player-card-overlay .game-name")).toHaveText(`BUF @ MIA — ${time}`);
});

test("contention accounts for shared picks, and eliminated players appear last", async ({ page }) => {
    await mockDashboard(page, { "/data/2026/week01.json": week({
        players: [player("trailing"), player("leader"), player("opposite", {
            picks: { "game-1": "MIA" },
        })],
        results: { players: [result("trailing"), result("leader", { wins: 1 }), result("opposite")] },
    }) });
    await page.goto("/");
    await expect(page.locator("#player-list .player-name")).toHaveText([
        "leader", "opposite", "trailing",
    ]);
    await expect(page.locator(".eliminated-divider")).toHaveText("Eliminated");
    await expect(page.locator(".eliminated-divider + .player-card .player-name")).toHaveText("trailing");
});

test("completed weeks use official ranks, winners, and shared last place", async ({ page }) => {
    await mockDashboard(page, { "/data/2026/week01.json": week({
        games: [game("game-1", { status: "final", away_score: 7, home_score: 0 })],
        players: [player("last-a"), player("winner"), player("last-b")],
        results: { player_count: 3, monday_total: 0, weekly_winners: ["winner"], players: [
            result("last-a", { weekly_rank: 2 }),
            result("winner", { wins: 1, weekly_rank: 1, weekly_winner: true }),
            result("last-b", { weekly_rank: 2 }),
        ] },
    }) });
    await page.goto("/");
    await expect(page.locator("#week-status")).toHaveText("Week 1 Final");
    await expect(page.locator("#player-list .player-name")).toHaveText([
        "🏆 winner", "💩 last-a", "💩 last-b",
    ]);
    await expect(page.locator("#weekly-summary .summary-value")).toHaveText(["3", "1/1", "winner", "0"]);
    await expect(page.locator(".eliminated-divider")).toHaveCount(0);
});

test("Escape and the backdrop close cards; opening another leaves one overlay", async ({ page }) => {
    await mockDashboard(page, { "/data/2026/week01.json": week({ players: [player(), player("beth")] }) });
    await page.goto("/");
    const alex = page.locator("#player-list").getByRole("button", { name: /alex/ });
    await alex.click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".player-card-overlay")).toHaveCount(0);
    await expect(alex).toBeFocused();
    await alex.click();
    await page.locator(".player-card-overlay").click({ position: { x: 2, y: 2 } });
    await expect(page.locator(".player-card-overlay")).toHaveCount(0);
    await page.locator("#player-list").getByRole("button", { name: /beth/ }).click();
    await expect(page.locator(".player-card-overlay")).toHaveCount(1);
    await expect(page.locator(".player-card-overlay .player-name")).toHaveText("beth");
});
