import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAccuracy } from "../../../assets/format.js";
import { displayName, getPlayerName, rememberPlayerNames } from "../../../assets/players.js";

test("Win % distinguishes unavailable values from zero and rounds to one decimal", () => {
    for (const [input, expected] of [
        [null, "—"], [undefined, "—"], [0, "0"], [1, "100"], [2 / 3, "66.7"],
    ]) {
        assert.equal(formatAccuracy(input), expected);
    }
});

test("display names prefer nicknames and fall back to names", () => {
    assert.equal(displayName({ name: "Alex Example", nickname: "Ace" }), "Ace");
    assert.equal(displayName({ name: "Alex Example", nickname: "" }), "Alex Example");
    assert.equal(displayName({ name: "Alex Example" }), "Alex Example");
});

test("remembered names can be corrected and unknown IDs are humanized", () => {
    rememberPlayerNames([{ id: "unit-alex", name: "Alex Example", nickname: "Ace" }]);
    assert.equal(getPlayerName("unit-alex"), "Ace");
    rememberPlayerNames([{ id: "unit-alex", name: "Alex Corrected" }]);
    assert.equal(getPlayerName("unit-alex"), "Alex Corrected");
    assert.equal(getPlayerName("unknown-player"), "Unknown Player");
});
