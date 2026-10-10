import { test, expect } from "@playwright/test";
import { game, player, result, week, mockDashboard } from "./fixtures.js";

async function boxes(locator) {
    return locator.evaluateAll((elements) => elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
    }));
}

async function expectOrderedColumn(cards) {
    await expect(cards).toHaveCount(3);
    const bounds = await boxes(cards);
    for (const [index, bound] of bounds.entries()) {
        expect(bound.x).toBeCloseTo(bounds[0].x, 0);
        expect(bound.width).toBeCloseTo(bounds[0].width, 0);
        if (index > 0) expect(bound.y).toBeGreaterThanOrEqual(
            bounds[index - 1].y + bounds[index - 1].height,
        );
    }
}

async function loadCards(page, games = [game()]) {
    await mockDashboard(page, {
        "/data/2026/week01.json": week({ games,
            players: [player("alex"), player("beth"), player("casey")],
        }),
        "/data/2026/season.json": { season: 2026, weeks_scored: [1], players:
            ["alex", "beth", "casey"].map((id, index) => ({
                player_id: id, weeks_played: 1, wins: 10 - index, losses: index,
                ties: 0, missed_picks: index, accuracy: (10 - index) / 10,
                weekly_wins: index === 0 ? 1 : 0, last_place_finishes: index === 2 ? 1 : 0,
            })),
        },
    });
    await page.goto("/");
    await expect(page.locator("#player-list .player-card")).toHaveCount(3);
}

// Includes the old two-column breakpoint, the proposed boundary, and phone landscape.
for (const width of [390, 600, 799, 800, 844, 1280]) {
    test(`weekly and season cards preserve top-to-bottom order at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await loadCards(page);
        await expectOrderedColumn(page.locator("#player-list .player-card"));
        await expect(page.locator("#player-list .player-name")).toHaveText(["alex", "beth", "casey"]);
        await page.getByRole("button", { name: "🏆 Season" }).click();
        await expectOrderedColumn(page.locator("#season-list .season-card"));
        await expect(page.locator(".season-name")).toHaveText(["👑 1. alex", "2. beth", "3. casey"]);
    });
}

for (const width of [800, 844, 1280]) {
    test(`weekly resting card fits 16 picks in two rows at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const games = Array.from({ length: 16 }, (_, index) => game(`g-${index}`));
        const teams = games.map((_, index) => index % 2 ? "MIA" : "BUF");
        await mockDashboard(page, { "/data/2026/week01.json": week({ games,
            players: [player("alex", { picks: Object.fromEntries(games.map((g, i) => [g.id, teams[i]])) })],
            results: { players: [result("alex", { wins: 2, losses: 1, ties: 1, accuracy: 0.5 })] },
        }) });
        await page.goto("/");
        const card = page.locator("#player-list .player-card");
        const summary = card.locator(".player-summary");
        const picks = card.locator(".compact-picks");
        await expect(picks).toBeVisible();
        await expect(picks.locator(".pick-team")).toHaveText(teams);
        await expect(picks.locator(".pick-status")).toHaveText(Array(16).fill("⏳"));
        await expect(summary.locator(".player-record")).toHaveText("2-1-1");
        await expect(summary.locator(".player-accuracy")).toHaveText("Win %: 50");
        const top = await boxes(summary.locator(".player-name, .player-record, .player-accuracy"));
        expect(Math.max(...top.map((b) => b.y))).toBeLessThan(Math.min(...top.map((b) => b.y + b.height)));
        const pickBounds = await boxes(picks.locator(".pick-value"));
        const [cardBounds] = await boxes(card);
        const [summaryBounds] = await boxes(summary);
        for (const [index, bound] of pickBounds.entries()) {
            expect(bound.y).toBeCloseTo(pickBounds[0].y, 0);
            expect(bound.y).toBeGreaterThanOrEqual(summaryBounds.y + summaryBounds.height);
            expect(bound.x).toBeGreaterThanOrEqual(cardBounds.x);
            expect(bound.x + bound.width).toBeLessThanOrEqual(cardBounds.x + cardBounds.width);
            if (index > 0) expect(bound.x).toBeGreaterThanOrEqual(pickBounds[index - 1].x + pickBounds[index - 1].width);
        }
        expect(await picks.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await expect(card.locator(".player-details")).toBeHidden();
        await expect(card.locator(".player-name")).toHaveText("alex");
        await expect(card).not.toContainText("Eliminated");
        await expect(summary).not.toContainText("Tiebreaker");
        await expect(summary).not.toContainText("42");
        // The existing opener and detailed overlay remain available.
        await summary.click();
        const overlay = page.locator(".player-card-overlay");
        await expect(overlay.locator(".compact-picks")).toBeHidden();
        await expect(overlay.locator(".pick-row")).toHaveCount(16);
        await expect(overlay.locator(".detail-box").filter({ hasText: "Tiebreaker Pick" })).toContainText("42");
        await page.keyboard.press("Escape");
        await expect(summary).toBeFocused();
        // Crossing back below the breakpoint restores the existing stacked header.
        await page.setViewportSize({ width: 799, height: 900 });
        await expect(picks).toBeHidden();
        const [name, accuracy] = await boxes(summary.locator(".player-name, .player-accuracy"));
        expect(accuracy.y).toBeGreaterThanOrEqual(name.y + name.height);
    });
}

test("compact picks reuse outcome indicators, colors, and missing-pick behavior", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const games = [game("pending"),
        game("ahead", { status: "live", away_score: 7, home_score: 0 }),
        game("behind", { status: "live", away_score: 0, home_score: 7 }),
        game("correct", { status: "final", away_score: 7, home_score: 0 }),
        game("wrong", { status: "final", away_score: 0, home_score: 7 }),
        game("tie", { status: "final", away_score: 0, home_score: 0 }),
        game("missing-pending"),
        game("missing-final", { status: "final", away_score: 7, home_score: 0 })];
    await mockDashboard(page, { "/data/2026/week01.json": week({ games,
        players: [player("alex", { picks: Object.fromEntries(games.slice(0, 6).map((g) => [g.id, "BUF"])) })],
    }) });
    await page.goto("/");
    const picks = page.locator("#player-list .compact-picks");
    await expect(picks).toBeVisible();
    await expect(picks.locator(".pick-status")).toHaveText(["⏳", "🟢", "🟡", "✅", "❌", "➖", "⏳", "❌"]);
    await expect(picks.locator(".pick-team")).toHaveText([...Array(6).fill("BUF"), "N/P", "N/P"]);
    await page.locator("#player-list .player-summary").click();
    const details = page.locator(".player-card-overlay .pick-value");
    for (let index = 0; index < games.length; index++) {
        await expect(picks.locator(".pick-value").nth(index)).toHaveAttribute("class", await details.nth(index).getAttribute("class"));
        expect(await picks.locator(".pick-value").nth(index).evaluate((el) => getComputedStyle(el).color))
            .toBe(await details.nth(index).evaluate((el) => getComputedStyle(el).color));
    }
});

for (const width of [800, 1280]) {
    test(`season cards flatten stats and retain secondary content at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await loadCards(page);
        await page.getByRole("button", { name: "🏆 Season" }).click();
        const first = page.locator(".season-card").first();
        const top = await boxes(first.locator(".season-name, .season-record, .season-accuracy"));
        expect(Math.max(...top.map((b) => b.y))).toBeLessThan(Math.min(...top.map((b) => b.y + b.height)));
        await expect(page.locator(".season-record")).toHaveText(["10-0-0", "9-1-0", "8-2-0"]);
        await expect(page.locator(".season-meta")).toHaveText([
            "Weeks played: 1 • Missed picks: 0", "Weeks played: 1 • Missed picks: 1", "Weeks played: 1 • Missed picks: 2",
        ]);
        await expect(page.locator(".weekly-wins")).toHaveText(["🏆 1", "🏆 0", "🏆 0 • 💩 1"]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
}
