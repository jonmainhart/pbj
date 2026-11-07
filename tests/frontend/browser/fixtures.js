import { expect } from "@playwright/test";

export function game(id = "game-1", overrides = {}) {
  return {
    id,
    scheduled_time: "2026-09-13T17:00:00Z",
    away: { id: "buf", abbreviation: "BUF", name: "Buffalo Bills" },
    home: { id: "mia", abbreviation: "MIA", name: "Miami Dolphins" },
    status: "scheduled",
    away_score: null,
    home_score: null,
    ...overrides,
  };
}

export function player(id = "alex", overrides = {}) {
  return {
    id,
    name: id,
    nickname: null,
    picks: { "game-1": "BUF" },
    tiebreaker: 42,
    ...overrides,
  };
}

export function result(id, overrides = {}) {
  return {
    player_id: id,
    wins: 0,
    losses: 0,
    ties: 0,
    missed_picks: 0,
    accuracy: null,
    weekly_rank: null,
    weekly_winner: false,
    tiebreaker_distance: null,
    ...overrides,
  };
}

export function week(overrides = {}) {
  return {
    season: 2026,
    week: 1,
    lock_time: "2026-09-13T16:00:00Z",
    games: [game()],
    players: [player()],
    results: null,
    ...overrides,
  };
}

// Only data requests are replaced; HTML, styles, and modules come from the real site.
// A function response lets refresh tests change server data without remounting the app.
export async function mockDashboard(page, responses = {}) {
  const routes = {
    "/data/available-weeks.json": { 2026: [1] },
    "/data/2026/week01.json": week(),
    "/data/2026/season.json": { season: 2026, weeks_scored: [], players: [] },
    "/data/announcements.json": {
      top: { text: "", link: null },
      bottom: { text: "", link: null },
    },
    ...responses,
  };
  await page.route(/\/data\/.*$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const value =
      typeof routes[path] === "function" ? routes[path]() : routes[path];
    if (value === undefined || value === null) {
      await route.fulfill({ status: 404 });
    } else if (typeof value === "string") {
      await route.fulfill({ contentType: "text/plain", body: value });
    } else {
      await route.fulfill({ json: value });
    }
  });
}

// Observe weekly fetch consumption without changing the application's response.
// MessageChannel runs after the promise continuations that parse and render the
// week. Unlike a timeout, it also works while Playwright's clock is paused.
export async function trackWeekProcessing(page) {
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.processedWeeks = 0;
    const processed = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        window.processedWeeks++;
        channel.port1.close();
        channel.port2.close();
      };
      channel.port2.postMessage(null);
    };
    window.fetch = async (...args) => {
      if (!/\/week\d+\.json$/.test(String(args[0]))) return fetch(...args);
      try {
        const response = await fetch(...args);
        if (!response.ok) {
          processed();
          return response;
        }
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            processed();
          }
        };
        return response;
      } catch (error) {
        processed();
        throw error;
      }
    };
  });
  return async (count) => {
    await expect.poll(() => page.evaluate(() => window.processedWeeks)).toBe(count);
  };
}
