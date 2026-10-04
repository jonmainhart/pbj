import { test } from "node:test";
import assert from "node:assert/strict";
import { openEntity, crossNavigate, closeEntity } from "../../../assets/weekly-navigation.js";

const playerA = { kind: "player", id: "a", pageScroll: 320, cardScroll: 140 };
const playerB = { kind: "player", id: "b", pageScroll: 0, cardScroll: 0 };
const gameOne = { kind: "game", id: "1", pageScroll: 90, cardScroll: 60 };
const gameTwo = { kind: "game", id: "2", pageScroll: 0, cardScroll: 0 };
const empty = { view: "players", active: null, returnTo: null };

for (const [origin, destination] of [[playerA, gameOne], [gameOne, playerA]]) {
    test(`${origin.kind} → ${destination.kind} → close restores origin once`, () => {
        const root = openEntity(empty, origin);
        const before = structuredClone(root);
        const crossed = crossNavigate(root, destination);
        assert.deepEqual(crossed, {
            view: destination.kind === "player" ? "players" : "games",
            active: destination, returnTo: origin,
        });
        assert.deepEqual(root, before);
        const restored = closeEntity(crossed);
        assert.deepEqual(restored, { ...root, returnTo: null });
        assert.deepEqual(closeEntity(restored), { view: root.view, active: null, returnTo: null });
    });
}

for (const [origin, middle, destination] of [
    [playerA, gameOne, playerB], [gameOne, playerA, gameTwo],
]) {
    test(`${origin.kind} → ${middle.kind} → another ${destination.kind} establishes a new root`, () => {
        const second = crossNavigate(crossNavigate(openEntity(empty, origin), middle), destination);
        assert.equal(second.returnTo, null);
        assert.deepEqual(second.active, destination);
        assert.deepEqual(closeEntity(second), { view: second.view, active: null, returnTo: null });
        const freshCrossing = crossNavigate(second, middle);
        assert.deepEqual(closeEntity(freshCrossing).active, destination);
    });
}

test("explicit root opening discards an existing return context", () => {
    const crossed = crossNavigate(openEntity(empty, playerA), gameOne);
    const root = openEntity(crossed, gameTwo);
    assert.deepEqual(root, { view: "games", active: gameTwo, returnTo: null });
});

test("closing an already closed view is harmless", () => {
    assert.deepEqual(closeEntity(empty), empty);
});
