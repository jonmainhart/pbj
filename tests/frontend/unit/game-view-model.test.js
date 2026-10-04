import { test } from "node:test";
import assert from "node:assert/strict";
import { orderGames, groupGamePicks } from "../../../assets/game-view-model.js";
import { game, player } from "../browser/fixtures.js";

test("unfinished games precede finals with kickoff order retained within each group", () => {
    const games = [
        game("final-late", { status: "final", scheduled_time: "2026-09-14T00:00:00Z" }),
        game("scheduled-late", { scheduled_time: "2026-09-13T20:00:00Z" }),
        game("live-early", { status: "live" }),
        game("final-early", { status: "final" }),
        game("same-time"),
    ];
    const before = structuredClone(games);
    const ordered = orderGames(games);
    assert.deepEqual(ordered.map((g) => g.id), [
        "live-early", "same-time", "scheduled-late", "final-early", "final-late",
    ]);
    assert.deepEqual(games, before);
    assert.notEqual(ordered, games);
    assert.equal(ordered[0], games[2]);
});

test("an empty schedule produces an empty list", () => {
    assert.deepEqual(orderGames([]), []);
});

test("picks are grouped by this game's teams and absent picks become N/P", () => {
    const selectedGame = game("provider-event-42");
    const players = [
        player("home", { picks: { "provider-event-42": "MIA" } }),
        player("missing", { picks: { "different-game": "BUF" } }),
        player("away", { nickname: "Ace", picks: { "provider-event-42": "BUF" } }),
        player("away-two", { picks: { "provider-event-42": "BUF" } }),
    ];
    const before = structuredClone({ selectedGame, players });
    const groups = groupGamePicks(selectedGame, players);
    assert.deepEqual(groups.map(({ team, players }) => ({
        team, ids: players.map((p) => p.id),
    })), [
        { team: "BUF", ids: ["away", "away-two"] },
        { team: "MIA", ids: ["home"] },
        { team: "N/P", ids: ["missing"] },
    ]);
    assert.equal(groups[0].players[0], players[2]);
    assert.deepEqual({ selectedGame, players }, before);
});

test("all three groups exist even before picks are imported", () => {
    assert.deepEqual(groupGamePicks(game(), []), [
        { team: "BUF", players: [] },
        { team: "MIA", players: [] },
        { team: "N/P", players: [] },
    ]);
});
