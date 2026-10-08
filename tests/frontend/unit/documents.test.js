import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDocument } from "../../../assets/documents.js";

for (const path of ["./assets/documents/rules.html", "./assets/documents/example.html"]) {
    test(`document loader returns trusted HTML from ${path}`, async (t) => {
        const html = "<h1>Example</h1><p>A complete document.</p>";
        const fetch = t.mock.method(globalThis, "fetch", async () => ({
            ok: true, text: async () => html,
        }));
        assert.equal(await loadDocument(path), html);
        assert.deepEqual(fetch.mock.calls[0].arguments, [path, { cache: "no-store" }]);
    });
}

test("document loader reports unsuccessful HTTP responses", async (t) => {
    t.mock.method(globalThis, "fetch", async () => ({ ok: false }));
    await assert.rejects(() => loadDocument("./assets/documents/rules.html"), {
        message: "Unable to load document.",
    });
});

test("document loader propagates network failures", async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
    await assert.rejects(() => loadDocument("./assets/documents/rules.html"), { message: "offline" });
});
