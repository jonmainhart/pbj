import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const baseURL = "http://127.0.0.1:8000";
const python = process.env.PBJ_PYTHON
    || (existsSync(".venv/bin/python") ? ".venv/bin/python" : "python3");
const pythonCommand = `'${python.replaceAll("'", "'\\''")}'`;

export default defineConfig({
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
        command: `${pythonCommand} -m scripts.build_site && ${pythonCommand} -m http.server 8000 --bind 127.0.0.1 --directory build/site`,
        url: baseURL,
        reuseExistingServer: false,
    },
});
