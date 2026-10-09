import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mockDashboard } from "./fixtures.js";

const trigger = (page) => page.getByRole("contentinfo")
    .getByRole("button", { name: "Legal Notice", exact: true });

async function setup(page) {
    await mockDashboard(page);
    await page.route("**/assets/documents/legal.html", (route) => route.fulfill({
        contentType: "text/html",
        body: '<h1>Legal Notice</h1><p>Test notice. <a href="LICENSE-SCOPE.md">Licensing Scope</a>.</p>',
    }));
    await page.goto("/");
    await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
    await expect(trigger(page)).toBeVisible();
}

test("Legal Notice opens test content and its Licensing Scope link resolves", async ({ page }) => {
    await setup(page);
    const url = page.url();
    const response = page.waitForResponse((r) => r.url().endsWith("/assets/documents/legal.html"));
    await trigger(page).click();
    expect((await response).ok()).toBe(true);
    const card = page.getByRole("dialog", { name: "Legal Notice", exact: true });
    await expect(card).toHaveAttribute("aria-modal", "true");
    await expect(card.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await expect(card).toContainText("Test notice.");
    const link = card.getByRole("link", { name: "Licensing Scope", exact: true });
    const target = await link.evaluate((element) => element.href);
    expect(target).toBe(new URL("LICENSE-SCOPE.md", url).href);
    const scope = await page.request.get(target);
    expect(scope.ok()).toBe(true);
    expect(await scope.text()).toBe(readFileSync(new URL("../../../LICENSE-SCOPE.md", import.meta.url), "utf8"));
    await expect(page).toHaveURL(url);
});

// Reuse shared-card coverage; only check the new control's wiring and restoration.
for (const method of ["Close", "Escape", "backdrop"]) {
    test(`Legal Notice: ${method} restores trigger and dashboard state`, async ({ page }) => {
        await setup(page);
        await page.getByRole("button", { name: "Games", exact: true }).click();
        const week = await page.locator("#week-select").inputValue();
        const url = page.url();
        await trigger(page).scrollIntoViewIfNeeded();
        const scroll = await page.evaluate(() => window.scrollY);
        await trigger(page).click();
        const card = page.getByRole("dialog", { name: "Legal Notice", exact: true });
        await expect(card).toContainText("Test notice.");
        if (method === "Close") await card.getByRole("button", { name: "Close", exact: true }).click();
        else if (method === "Escape") await page.keyboard.press("Escape");
        else await page.mouse.click(2, 2);
        await expect(card).toHaveCount(0);
        await expect(trigger(page)).toBeFocused();
        await expect(page.locator("#week-select")).toHaveValue(week);
        await expect(page.getByRole("button", { name: "Games", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(scroll - 8);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(scroll + 8);
        await expect(page).toHaveURL(url);
    });
}
