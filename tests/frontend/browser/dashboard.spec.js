import { test, expect } from "@playwright/test";
import { mockDashboard, player as fixturePlayer, week } from "./fixtures.js";

test(
  "weekly dashboard loads and a player card opens and closes",
  { tag: "@smoke" },
  async ({ page }) => {
    await mockDashboard(page, {
      "/data/2026/week01.json": week({
        players: [fixturePlayer("alex-example", { name: "Alex Example" })],
      }),
    });
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "PBJ Football" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Week 1", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Week", exact: true }),
    ).toHaveValue("1");
    await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
    await expect(page.locator("#weekly-message")).toBeEmpty();
    await expect(page.locator("#season-view")).toBeHidden();

    const player = page.locator("#player-list").getByRole("button", {
      name: /Alex Example/,
    });
    await expect(player).toHaveAttribute("aria-expanded", "false");
    await player.click();

    const overlay = page.locator(".player-card-overlay");
    const expandedPlayer = overlay.getByRole("button", {
      name: /Alex Example/,
    });
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
  },
);
