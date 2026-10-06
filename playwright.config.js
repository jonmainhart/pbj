import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:8000";

export default defineConfig({
    globalSetup: "./tests/frontend/browser/global-setup.js",
    testDir: "./tests/frontend/browser",
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [
        {
            name: "desktop-chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: "python3 -m http.server 8000 --bind 127.0.0.1",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
    },
});
