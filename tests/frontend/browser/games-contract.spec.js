import { test, expect } from "@playwright/test";
import { game, player, week, mockDashboard } from "./fixtures.js";

const gameOne = game("one");
const gameTwo = game("two", {
    scheduled_time: "2026-09-13T20:00:00Z",
    away: { id: "nyj", abbreviation: "NYJ", name: "New York Jets" },
    home: { id: "ne", abbreviation: "NE", name: "New England Patriots" },
});
const players = [
    player("alex", { nickname: "Ace", picks: { one: "BUF", two: "NYJ" } }),
    player("beth", { picks: { one: "MIA", two: "NE" } }),
    player("casey", { picks: {} }),
];
const details = (page, kind) => page.getByRole("dialog", { name: `${kind} details`, exact: true });
const gamesList = (page) => page.getByRole("region", { name: "Games", exact: true });
const playerSummary = (page, name = "Ace") => page.locator("#player-list")
    .getByRole("button", { name: new RegExp(name) });
const gameSummary = (page, matchup = /BUF.*MIA/) => gamesList(page)
    .getByRole("button", { name: matchup });

async function load(page, data = week({ games: [gameOne, gameTwo], players })) {
    await mockDashboard(page, { "/data/2026/week01.json": data });
    await page.goto("/");
    await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
}

async function showGames(page) {
    await page.getByRole("button", { name: "Games", exact: true }).click();
    await expect(gamesList(page)).toBeVisible();
}

async function close(page, kind, method, summaryName) {
    const dialog = details(page, kind);
    if (method === "summary") {
        await dialog.getByRole("button", { name: summaryName }).click();
    } else if (method === "Escape") {
        await page.keyboard.press("Escape");
    } else {
        // Outside the centered card, within the full-screen backdrop.
        await page.mouse.click(2, 2);
    }
}

test("Players is the default; toggle retains the selected week and URL", async ({ page }) => {
    await load(page);
    const playersToggle = page.getByRole("button", { name: "Players", exact: true });
    const gamesToggle = page.getByRole("button", { name: "Games", exact: true });
    await expect(playersToggle).toHaveAttribute("aria-pressed", "true");
    await expect(gamesToggle).toHaveAttribute("aria-pressed", "false");
    await expect(gamesList(page)).toBeHidden();
    await showGames(page);
    await expect(gamesToggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#player-list")).toBeHidden();
    await expect(page.locator("#week-select")).toHaveValue("1");
    await expect(page).toHaveURL(/\?week=1$/);
    await playersToggle.click();
    await expect(playerSummary(page)).toBeVisible();
});

test("one card per game, ordered by kickoff with final games last", async ({ page }) => {
    const third = game("third", {
        scheduled_time: "2026-09-13T16:00:00Z",
        status: "final", away_score: 7, home_score: 0,
        away: { abbreviation: "DAL" }, home: { abbreviation: "PHI" },
    });
    const fourth = game("fourth", {
        scheduled_time: "2026-09-13T21:00:00Z",
        status: "final", away_score: 0, home_score: 7,
        away: { abbreviation: "KC" }, home: { abbreviation: "DEN" },
    });
    await load(page, week({ games: [fourth, gameTwo, third, gameOne], players }));
    await showGames(page);
    const cards = gamesList(page).getByRole("button");
    await expect(cards).toHaveCount(4);
    for (const [i, matchup] of [/BUF.*MIA/, /NYJ.*NE/, /DAL.*PHI/, /KC.*DEN/].entries()) {
        await expect(cards.nth(i)).toHaveText(matchup);
    }
    await expect(cards.nth(0)).toContainText(/Scheduled/i);
    await expect(cards.nth(2)).toContainText(/Final/i);
    await expect(cards.nth(2)).toContainText("7");
    await expect(cards.nth(2)).toContainText("0");
});

for (const entry of [
    { status: "scheduled", away: null, home: null, icons: ["⏳", "⏳", "⏳"],
        classes: ["pending", "pending", "pending"] },
    { status: "live", away: 7, home: 0, icons: ["🟢", "🟡", "⏳"],
        classes: ["live", "live-losing", "pending"] },
    { status: "live", away: 0, home: 0, icons: ["🟢", "🟢", "⏳"],
        classes: ["live", "live", "pending"] },
    { status: "live", away: null, home: null, icons: ["🟢", "🟢", "⏳"],
        classes: ["live", "live", "pending"] },
    { status: "final", away: 7, home: 0, icons: ["✅", "❌", "❌"],
        classes: ["correct", "wrong", "wrong"] },
    { status: "final", away: 0, home: 0, icons: ["➖", "➖", "❌"],
        classes: ["tie", "tie", "wrong"] },
]) {
    test(`game groups reuse pick semantics: ${entry.status} ${entry.away}-${entry.home}`, async ({ page }) => {
        await load(page, week({ games: [game("one", {
            status: entry.status, away_score: entry.away, home_score: entry.home,
        }), gameTwo], players }));
        await showGames(page);
        await gameSummary(page).click();
        const dialog = details(page, "Game");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("button", { name: /BUF.*MIA/ })).toBeFocused();
        for (const [i, team] of ["BUF", "MIA", "N/P"].entries()) {
            const group = dialog.getByRole("region", { name: team, exact: true });
            const picker = group.getByRole("button", { name: new RegExp(["Ace", "beth", "casey"][i]) });
            await expect(picker).toBeVisible();
            await expect(picker).toContainText(entry.icons[i]);
            await expect(picker).toHaveClass(new RegExp(`\\bpick-${entry.classes[i]}\\b`));
        }
        await expect(page.getByRole("dialog")).toHaveCount(1);
    });
}

for (const method of ["summary", "Escape", "backdrop"]) {
    test(`Player → Game → ${method} restores the originating player and focus`, async ({ page }) => {
        await load(page);
        await playerSummary(page).click();
        await details(page, "Player").getByRole("button", { name: /BUF.*MIA/ }).click();
        await expect(details(page, "Player")).toHaveCount(0);
        await expect(details(page, "Game")).toBeVisible();
        await expect(page.getByRole("button", { name: "Games", exact: true })).toHaveAttribute("aria-pressed", "true");
        await close(page, "Game", method, /BUF.*MIA/);
        const restored = details(page, "Player").getByRole("button", { name: /Ace/ });
        await expect(restored).toBeFocused();
        await expect(restored).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByRole("dialog")).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(playerSummary(page)).toBeFocused();
    });

    test(`Game → Player → ${method} restores the originating game and focus`, async ({ page }) => {
        await load(page);
        await showGames(page);
        await gameSummary(page).click();
        await details(page, "Game").getByRole("button", { name: /Ace/ }).click();
        await expect(details(page, "Player")).toBeVisible();
        await close(page, "Player", method, /Ace/);
        await expect(details(page, "Game").getByRole("button", { name: /BUF.*MIA/ })).toBeFocused();
        await expect(page.getByRole("dialog")).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(gameSummary(page)).toBeFocused();
    });
}

test("Player A → Game → Player B closes at Player B without returning through history", async ({ page }) => {
    await load(page);
    await playerSummary(page).click();
    await details(page, "Player").getByRole("button", { name: /BUF.*MIA/ }).click();
    await details(page, "Game").getByRole("button", { name: /beth/ }).click();
    await expect(details(page, "Player").getByRole("button", { name: /beth/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(playerSummary(page, "beth")).toBeFocused();
});

test("Game 1 → Player → Game 2 closes at Game 2 without returning through history", async ({ page }) => {
    await load(page);
    await showGames(page);
    await gameSummary(page).click();
    await details(page, "Game").getByRole("button", { name: /Ace/ }).click();
    await details(page, "Player").getByRole("button", { name: /NYJ.*NE/ }).click();
    await expect(details(page, "Game").getByRole("button", { name: /NYJ.*NE/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(gameSummary(page, /NYJ.*NE/)).toBeFocused();
});

test("narrow-screen drill-down restores player card and page scroll without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    const games = Array.from({ length: 24 }, (_, i) => game(`long-${i}`));
    const picks = Object.fromEntries(games.map((g) => [g.id, "BUF"]));
    const longPlayers = Array.from({ length: 20 }, (_, i) => player(`person-${i}`, { picks }));
    await load(page, week({ games, players: longPlayers }));
    await playerSummary(page, "person-19").click();
    const dialog = details(page, "Player");
    await dialog.evaluate((element) => { element.scrollTop = 180; });
    const target = dialog.getByRole("button", { name: /BUF.*MIA/ }).nth(4);
    await target.scrollIntoViewIfNeeded();
    const origin = await dialog.evaluate((element) => ({ page: window.scrollY, card: element.scrollTop }));
    expect(origin.card).toBeGreaterThan(0);
    await target.click();
    await expect(details(page, "Game")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await details(page, "Game").boundingBox();
    expect(box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeLessThanOrEqual(700);
    await page.keyboard.press("Escape");
    await expect(details(page, "Player")).toBeVisible();
    await expect.poll(() => details(page, "Player").evaluate((element) => element.scrollTop))
        .toBeGreaterThanOrEqual(origin.card - 8);
    await expect.poll(() => details(page, "Player").evaluate((element) => element.scrollTop))
        .toBeLessThanOrEqual(origin.card + 8);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(origin.page - 8);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(origin.page + 8);
});

test("Game → Player → close restores a scrolled game picker list", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    const manyPlayers = Array.from({ length: 40 }, (_, i) => player(`person-${i}`, {
        picks: { one: "BUF", two: "NYJ" },
    }));
    await load(page, week({ games: [gameOne, gameTwo], players: manyPlayers }));
    await showGames(page);
    await gameSummary(page).click();
    const dialog = details(page, "Game");
    const target = dialog.getByRole("button", { name: /person-30\b/ });
    await target.scrollIntoViewIfNeeded();
    const origin = await dialog.evaluate((element) => ({ page: window.scrollY, card: element.scrollTop }));
    expect(origin.card).toBeGreaterThan(0);
    await target.click();
    await expect(details(page, "Player")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details(page, "Game")).toBeVisible();
    await expect.poll(() => details(page, "Game").evaluate((element) => element.scrollTop))
        .toBeGreaterThanOrEqual(origin.card - 8);
    await expect.poll(() => details(page, "Game").evaluate((element) => element.scrollTop))
        .toBeLessThanOrEqual(origin.card + 8);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(origin.page - 8);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(origin.page + 8);
});

test("closing a root game leaves Games selected and permits opening another game", async ({ page }) => {
    await load(page);
    await showGames(page);
    await gameSummary(page).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(gameSummary(page)).toBeFocused();
    await gameSummary(page, /NYJ.*NE/).click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(details(page, "Game").getByRole("button", { name: /NYJ.*NE/ }))
        .toHaveAttribute("aria-expanded", "true");
});

test("refresh pauses for an open game and retains Games when changed data arrives", async ({ page }) => {
    await page.clock.install();
    let requests = 0;
    let current = week({ games: [gameOne, gameTwo], players });
    await mockDashboard(page, { "/data/2026/week01.json": () => { requests += 1; return current; } });
    await page.goto("/");
    await showGames(page);
    await gameSummary(page).click();
    current = week({ games: [game("one", { status: "live", away_score: 7, home_score: 0 }), gameTwo], players });
    await page.clock.runFor(60_000);
    expect(requests).toBe(1);
    await expect(details(page, "Game")).toBeVisible();
    await page.keyboard.press("Escape");
    const response = page.waitForResponse((r) => r.url().endsWith("/week01.json"));
    await page.clock.runFor(60_000);
    await response;
    await expect(gameSummary(page)).toContainText(/Live/i);
    await expect(gameSummary(page)).toContainText("7");
    await expect(page.getByRole("button", { name: "Games", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a week change clears navigation context and starts the new week in Players", async ({ page }) => {
    await mockDashboard(page, {
        "/data/available-weeks.json": { "2026": [1, 2] },
        "/data/2026/week01.json": week({ games: [gameOne, gameTwo], players }),
        "/data/2026/week02.json": week({ week: 2, games: [gameOne, gameTwo], players }),
    });
    await page.goto("/?week=1");
    await playerSummary(page).click();
    await details(page, "Player").getByRole("button", { name: /BUF.*MIA/ }).click();
    // selectOption changes the underlying selector even while the overlay is open.
    await page.getByRole("combobox", { name: "Week" }).selectOption("2");
    await expect(page.locator("#week-status")).toHaveText("Week 2 In Progress");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Players", exact: true })).toHaveAttribute("aria-pressed", "true");
    await showGames(page);
    await gameSummary(page).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a delayed refresh cannot replace a game card opened while the request was pending", async ({ page }) => {
    await page.clock.install();
    await load(page);
    let release;
    let notify;
    const pending = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { notify = resolve; });
    await page.route("**/week01.json", async (route) => {
        notify();
        await pending;
        await route.fulfill({ json: week({ games: [
            game("one", { status: "live", away_score: 7, home_score: 0 }), gameTwo,
        ], players }) });
    });
    await page.clock.runFor(60_000);
    await started;
    await showGames(page);
    await gameSummary(page).click();
    const response = page.waitForResponse((r) => r.url().endsWith("/week01.json"));
    release();
    await response;
    await page.clock.runFor(100);
    await expect(details(page, "Game")).toBeVisible();
    await expect(details(page, "Game").getByRole("button", { name: /BUF.*MIA/ })).toContainText("Scheduled");
});
