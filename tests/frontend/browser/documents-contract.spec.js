import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mockDashboard, week, player } from "./fixtures.js";

// Synthetic document content exercises presentation, not the pool's scoring rules.
const documentHTML = "<h1>Fixture Rules</h1><h2>First section</h2>"
    + "<p>A <strong>formatted</strong> document with <code>inline code</code>.</p>"
    + '<ul><li>First item</li><li>Last item</li></ul><a href="#first-section">Read more</a>';
const rules = (page) => page.getByRole("button", { name: "Rules", exact: true });
const dialog = (page) => page.getByRole("dialog", { name: "Pool Rules", exact: true });
const close = (page) => dialog(page).getByRole("button", { name: "Close", exact: true });

async function setup(page, html = documentHTML, responses = {}) {
    await mockDashboard(page, responses);
    await page.route("**/assets/documents/rules.html", (route) => route.fulfill({
        contentType: "text/html", body: html,
    }));
    await page.goto("/");
    await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
}

test("Rules loads the generated canonical document from the static server", async ({ page }) => {
    const source = readFileSync(new URL("../../../RULES.md", import.meta.url), "utf8");
    const headings = [...source.matchAll(/^#{1,6} (.+)$/gm)].map((match) => match[1]);
    await mockDashboard(page);
    await page.goto("/");
    await rules(page).click();
    for (const heading of headings) {
        await expect(dialog(page).getByRole("heading", { name: heading, exact: true })).toHaveCount(1);
    }
    await expect(dialog(page).getByRole("listitem")).not.toHaveCount(0);
    await expect(close(page)).toBeFocused();
});

test("footer Rules opens a formatted document without navigating away", async ({ page }) => {
    await setup(page);
    await expect(page.getByRole("contentinfo").getByRole("button", { name: "Rules", exact: true })).toBeVisible();
    const url = page.url();
    await rules(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute("aria-modal", "true");
    await expect(close(page)).toBeFocused();
    await expect(dialog(page).getByRole("heading", { name: "Fixture Rules" })).toBeVisible();
    await expect(dialog(page).getByRole("listitem")).toHaveText(["First item", "Last item"]);
    await expect(dialog(page).locator("strong")).toHaveText("formatted");
    await expect(dialog(page).locator("code")).toHaveText("inline code");
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    // License controls remain the existing links until issue #41.
    await expect(page.getByRole("link", { name: "Apache 2.0", exact: true })).toHaveAttribute("href", "/LICENSE");
});

for (const method of ["close button", "Escape", "backdrop"]) {
    test(`${method} closes Rules and restores trigger focus and page scroll`, async ({ page }) => {
        await setup(page);
        await rules(page).scrollIntoViewIfNeeded();
        const scroll = await page.evaluate(() => window.scrollY);
        await rules(page).click();
        await expect(dialog(page)).toBeVisible();
        if (method === "close button") await close(page).click();
        else if (method === "Escape") await page.keyboard.press("Escape");
        else await page.mouse.click(2, 2);
        await expect(dialog(page)).toHaveCount(0);
        await expect(rules(page)).toBeFocused();
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(scroll - 8);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(scroll + 8);
        await expect(page.locator("body")).not.toHaveClass(/\bcard-open\b/);
    });
}

test("Rules preserves Games selection, selected week, and URL", async ({ page }) => {
    await setup(page);
    await page.getByRole("button", { name: "Games", exact: true }).click();
    const url = page.url();
    await rules(page).click();
    await close(page).click();
    await expect(page.getByRole("button", { name: "Games", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "Games", exact: true })).toBeVisible();
    await expect(page.locator("#week-select")).toHaveValue("1");
    await expect(page).toHaveURL(url);
});

test("Rules is available in Season and dismissal retains the season view", async ({ page }) => {
    await setup(page);
    await page.getByRole("button", { name: "🏆 Season" }).click();
    await expect(page.locator("#season-message")).toHaveText("No completed weeks yet.");
    await rules(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator("#season-view")).toBeVisible();
    await expect(page.locator("#season-tab")).toHaveAttribute("aria-selected", "true");
    await expect(rules(page)).toBeFocused();
});

test("Rules remains available when pool data cannot load", async ({ page }) => {
    await mockDashboard(page, { "/data/available-weeks.json": null });
    await page.route("**/assets/documents/rules.html", (route) => route.fulfill({
        contentType: "text/html", body: documentHTML,
    }));
    await page.goto("/");
    await expect(page.locator("#weekly-message")).toHaveText("Available weeks could not be loaded.");
    await rules(page).click();
    await expect(dialog(page).getByRole("heading", { name: "Fixture Rules" })).toBeVisible();
});

test("keyboard containment includes document links as well as buttons", async ({ page }) => {
    await setup(page);
    await rules(page).click();
    const link = dialog(page).getByRole("link", { name: "Read more" });
    await expect(link).toBeVisible();
    await close(page).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(link).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
});

test("loading can be dismissed and a late response cannot reopen the card", async ({ page }) => {
    await setup(page);
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    await page.route("**/assets/documents/rules.html", async (route) => {
        await pending;
        await route.fulfill({ contentType: "text/html", body: documentHTML });
    });
    await rules(page).click();
    await expect(dialog(page).getByText("Loading…", { exact: true })).toBeVisible();
    // Either ignoring a late response or aborting the fetch is a valid implementation.
    let completed;
    const settled = new Promise((resolve) => { completed = resolve; });
    const onSettled = (request) => {
        if (request.url().endsWith("/documents/rules.html")) completed();
    };
    page.on("requestfinished", onSettled);
    page.on("requestfailed", onSettled);
    await close(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.locator("#player-list").getByRole("button", { name: /alex/ }).click();
    release();
    await settled;
    page.off("requestfinished", onSettled);
    page.off("requestfailed", onSettled);
    await expect(page.getByRole("dialog", { name: "Player details", exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(1);
});

for (const failure of ["HTTP", "network"]) {
    test(`${failure} failure shows an error, permits closing, and reopening retries`, async ({ page }) => {
        await setup(page);
        let attempts = 0;
        await page.route("**/assets/documents/rules.html", async (route) => {
            attempts += 1;
            if (attempts > 1) await route.fulfill({ contentType: "text/html", body: documentHTML });
            else if (failure === "HTTP") await route.fulfill({ status: 404 });
            else await route.abort();
        });
        await rules(page).click();
        await expect(dialog(page).getByRole("alert")).toContainText(/unable|could not/i);
        await close(page).click();
        await expect(rules(page)).toBeFocused();
        await rules(page).click();
        await expect(dialog(page).getByRole("heading", { name: "Fixture Rules" })).toBeVisible();
        expect(attempts).toBe(2);
    });
}

test("long documents scroll at phone width while Close remains usable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    const longHTML = "<h1>Long document</h1>" + Array.from({ length: 80 }, (_, i) =>
        `<p>Paragraph ${i}: a sufficiently long line of trusted project content.</p>`,
    ).join("");
    await setup(page, longHTML);
    await rules(page).click();
    await expect(dialog(page).getByText(/Paragraph 79:/)).toHaveCount(1);
    const end = dialog(page).getByText(/Paragraph 79:/);
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeVisible();
    await expect.poll(() => dialog(page).evaluate((element) =>
        [element, ...element.querySelectorAll("*")].some((node) => node.scrollTop > 0),
    )).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const bounds = await dialog(page).boundingBox();
    expect(bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.height).toBeLessThanOrEqual(700);
    const closeBounds = await close(page).boundingBox();
    expect(closeBounds.y).toBeGreaterThanOrEqual(0);
    expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(700);
    await close(page).click();
    await expect(rules(page)).toBeFocused();
});

test("refresh pauses for Rules and resumes after dismissal", async ({ page }) => {
    await page.clock.install();
    let requests = 0;
    let current = week();
    await setup(page, documentHTML, { "/data/2026/week01.json": () => { requests += 1; return current; } });
    await rules(page).click();
    current = week({ players: [player("beth")] });
    await page.clock.runFor(60_000);
    expect(requests).toBe(1);
    await expect(dialog(page)).toBeVisible();
    await close(page).click();
    const response = page.waitForResponse((r) => r.url().endsWith("/week01.json"));
    await page.clock.runFor(60_000);
    await response;
    await expect(page.locator("#player-list .player-name")).toHaveText("beth");
});

test("an in-flight refresh cannot close a newly opened Rules card", async ({ page }) => {
    await page.clock.install();
    await setup(page);
    let release;
    let notify;
    const pending = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { notify = resolve; });
    await page.route("**/week01.json", async (route) => {
        notify();
        await pending;
        await route.fulfill({ json: week({ players: [player("beth")] }) });
    });
    await page.clock.runFor(60_000);
    await started;
    await rules(page).click();
    const response = page.waitForResponse((r) => r.url().endsWith("/week01.json"));
    release();
    await response;
    await page.clock.runFor(100);
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator("#player-list .player-name")).toHaveText("alex");
});
