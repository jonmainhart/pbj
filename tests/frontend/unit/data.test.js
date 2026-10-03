import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWeek, fetchSeason, fetchAvailableWeeks } from "../../../assets/data.js";

const cases = [
    { name: "week", load: () => fetchWeek(2026, 4), path: "./data/2026/week04.json",
        options: { cache: "no-store" }, error: "Week 4 is not available yet." },
    { name: "season", load: () => fetchSeason(2026), path: "./data/2026/season.json",
        options: { cache: "no-store" }, error: "Season standings are not available yet." },
    { name: "manifest", load: fetchAvailableWeeks, path: "./data/available-weeks.json",
        options: undefined, error: "Available weeks could not be loaded." },
];

for (const entry of cases) {
    test(`${entry.name} loads JSON from the expected URL`, async (t) => {
        const data = { fixture: entry.name };
        const fetch = t.mock.method(globalThis, "fetch", async () => ({
            ok: true, json: async () => data,
        }));
        assert.deepEqual(await entry.load(), data);
        assert.equal(fetch.mock.calls[0].arguments[0], entry.path);
        assert.deepEqual(fetch.mock.calls[0].arguments[1], entry.options);
    });

    test(`${entry.name} reports an unavailable response`, async (t) => {
        t.mock.method(globalThis, "fetch", async () => ({ ok: false }));
        await assert.rejects(entry.load, { message: entry.error });
    });

    test(`${entry.name} propagates network failures`, async (t) => {
        t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
        await assert.rejects(entry.load, { message: "offline" });
    });
}
