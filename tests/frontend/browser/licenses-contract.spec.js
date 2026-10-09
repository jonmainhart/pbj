import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mockDashboard } from "./fixtures.js";

const documents = [
    { control: "Apache 2.0", source: "LICENSE", asset: "license.html" },
    { control: "Data & artwork terms", source: "LICENSE-SCOPE.md", asset: "license-scope.html" },
];
const sourceText = (name) => readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");
const licenseParagraphs = () => sourceText("LICENSE").trim().split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim().replace(/\s+/g, " "));
const trigger = (page, name) => page.getByRole("contentinfo").getByRole("button", { name, exact: true });
const dialog = (page) => page.getByRole("dialog");
const close = (page) => dialog(page).getByRole("button", { name: "Close", exact: true });

async function setup(page) {
    await mockDashboard(page);
    await page.goto("/");
    await expect(page.locator("#week-status")).toHaveText("Week 1 In Progress");
}

test("footer retains existing wording and adds Legal Notice", async ({ page }) => {
    await setup(page);
    await expect(page.getByRole("contentinfo")).toHaveText(
        "© 2026 Plus-Sized Squirrels • Code licensed under Apache 2.0 • Data & artwork terms • Rules • Legal Notice",
    );
});

for (const document of documents) {
    test(`${document.control} opens its generated canonical document without navigation`, async ({ page }) => {
        await setup(page);
        const url = page.url();
        await expect(trigger(page, document.control)).toBeVisible();
        const response = page.waitForResponse((r) => r.url().endsWith(`/assets/documents/${document.asset}`));
        await trigger(page, document.control).click();
        expect((await response).ok()).toBe(true);
        await expect(dialog(page)).toHaveCount(1);
        await expect(dialog(page)).toHaveAttribute("aria-modal", "true");
        await expect(close(page)).toBeFocused();
        const source = sourceText(document.source);
        if (document.source === "LICENSE") {
            // Every paragraph remains complete and in order, with source line wraps reflowed.
            await expect(dialog(page).locator(".document-content p")).toHaveText(licenseParagraphs());
            await expect(dialog(page).locator("pre")).toHaveCount(0);
            await expect(dialog(page).locator(".document-card-header").getByRole("heading", {
                name: /Apache.*2\.0/i,
            })).toBeVisible();
        } else {
            for (const match of source.matchAll(/^#{1,6} (.+)$/gm)) {
                await expect(dialog(page).getByRole("heading", { name: match[1], exact: true })).toHaveCount(1);
            }
            await expect(dialog(page).locator(".document-card-header").getByRole("heading", {
                name: "PBJ Dashboard Licensing Scope", exact: true,
            })).toBeVisible();
            await expect(dialog(page)).toContainText(source.trim().split("\n\n").at(-1).replace(/\n/g, " "));
            await expect(dialog(page).getByRole("link", { name: "LICENSE", exact: true })).toHaveCount(1);
        }
        await expect(page).toHaveURL(url);
    });

    for (const method of ["Close", "Escape", "backdrop"]) {
        test(`${document.control}: ${method} restores focus, scroll, and dashboard state`, async ({ page }) => {
            await setup(page);
            await page.getByRole("button", { name: "Games", exact: true }).click();
            const url = page.url();
            const selectedWeek = await page.locator("#week-select").inputValue();
            const control = trigger(page, document.control);
            await expect(control).toBeVisible();
            await control.scrollIntoViewIfNeeded();
            const scroll = await page.evaluate(() => window.scrollY);
            await control.click();
            await expect(dialog(page)).toBeVisible();
            if (method === "Close") await close(page).click();
            else if (method === "Escape") await page.keyboard.press("Escape");
            else await page.mouse.click(2, 2);
            await expect(dialog(page)).toHaveCount(0);
            await expect(control).toBeFocused();
            await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(scroll - 8);
            await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(scroll + 8);
            await expect(page.getByRole("button", { name: "Games", exact: true })).toHaveAttribute("aria-pressed", "true");
            await expect(page.getByRole("region", { name: "Games", exact: true })).toBeVisible();
            await expect(page.locator("#week-select")).toHaveValue(selectedWeek);
            await expect(page).toHaveURL(url);
            await expect(page.locator("body")).not.toHaveClass(/\bcard-open\b/);
        });
    }
}

for (const viewport of [{ width: 390, height: 700 }, { width: 1280, height: 800 }]) {
    test(`real Apache license scrolls without horizontal overflow at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await setup(page);
        await expect(trigger(page, "Apache 2.0")).toBeVisible();
        await trigger(page, "Apache 2.0").click();
        const paragraphs = dialog(page).locator(".document-content p");
        await expect(paragraphs).toHaveText(licenseParagraphs());
        await expect.poll(() => paragraphs.evaluateAll((elements) => elements.every((element) =>
            getComputedStyle(element).whiteSpace === "normal",
        ))).toBe(true);
        const card = dialog(page);
        await expect.poll(() => card.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        await card.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await expect.poll(() => card.evaluate((element) => element.scrollTop > 0
            && Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1)).toBe(true);
        await expect.poll(() => card.evaluate((element) =>
            [element, ...element.querySelectorAll("*")].every((node) => node.scrollWidth <= node.clientWidth),
        )).toBe(true);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const bounds = await card.boundingBox();
        expect(bounds.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds.height).toBeLessThanOrEqual(viewport.height);
        await expect(close(page)).toBeInViewport();
        await close(page).click();
        await expect(card).toHaveCount(0);
        await expect(trigger(page, "Apache 2.0")).toBeFocused();
    });
}
