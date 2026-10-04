import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeAutoRefresh } from "../../../assets/refresh.js";

test("refresh runs each minute only when visible, and on returning to the page", (t) => {
    let intervalCallback;
    let visibilityCallback;
    const document = { hidden: false, addEventListener(event, callback) {
        assert.equal(event, "visibilitychange");
        visibilityCallback = callback;
    } };
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    t.after(() => {
        for (const [name, descriptor] of [["window", originalWindow], ["document", originalDocument]]) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    globalThis.window = { setInterval(callback, delay) {
        assert.equal(delay, 60_000);
        intervalCallback = callback;
    } };
    globalThis.document = document;
    const refresh = t.mock.fn();
    initializeAutoRefresh(refresh);
    assert.equal(refresh.mock.callCount(), 0);
    intervalCallback();
    assert.equal(refresh.mock.callCount(), 1);
    document.hidden = true;
    intervalCallback();
    visibilityCallback();
    assert.equal(refresh.mock.callCount(), 1);
    document.hidden = false;
    visibilityCallback();
    assert.equal(refresh.mock.callCount(), 2);
});
