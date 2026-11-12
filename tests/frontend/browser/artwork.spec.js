import { test, expect } from "@playwright/test";
import { mockDashboard } from "./fixtures.js";

for (const width of [1280, 390]) {
  test(`dashboard artwork loads at viewport width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockDashboard(page);
    const response = page.waitForResponse("**/assets/img/pbj-hero.webp");
    await page.goto("/");
    expect((await response).ok()).toBe(true);
    const header = page.locator(".site-header");
    await expect(header).toBeVisible();
    await expect(header).toHaveCSS("background-image", /pbj-hero\.webp/);
    const dimensions = await header.evaluate(async (element) => {
      const image = new Image();
      image.src = getComputedStyle(element).backgroundImage.match(/url\("?(.+?)"?\)/)[1];
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
    expect(dimensions).toEqual([2048, 768]);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      "href", "assets/img/apple-touch-icon.png",
    );
    const manifest = await page.request.get("/manifest.webmanifest");
    expect((await manifest.json()).icons.map(({ src, type }) => [src, type])).toEqual([
      ["/assets/img/logo-192x192.png", "image/png"],
      ["/assets/img/logo-512x512.png", "image/png"],
    ]);
  });
}
