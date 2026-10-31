import { orderGames, groupGamePicks } from "./game-view-model.js";
import { formatGameDisplay } from "./game-display.js";
import { getPickStatus } from "./pick-status.js";
import { displayName } from "./players.js";

export function renderGames(games, players) {
    const container = document.querySelector("#game-list");
    container.replaceChildren(...orderGames(games).map((game) => createGameCard(game, players)));
}

function createGameCard(game, players) {
    const card = document.createElement("article");
    // Share the existing card visual language and overlay styles.
    card.className = "player-card game-card";
    card.dataset.entityKind = "game";
    card.dataset.entityId = game.id;

    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "player-summary game-summary";
    summary.dataset.openKind = "game";
    summary.dataset.openId = game.id;
    summary.setAttribute("aria-expanded", "false");
    const matchup = document.createElement("span");
    matchup.className = "game-matchup";
    matchup.textContent = formatGameDisplay(game)
        + (game.status === "scheduled" ? " — Scheduled" : "");
    summary.append(matchup);

    const body = document.createElement("div");
    body.className = "player-details";
    const inner = document.createElement("div");
    inner.className = "player-details-inner game-pickers";

    for (const group of groupGamePicks(game, players)) {
        const section = document.createElement("section");
        section.setAttribute("aria-label", group.team);
        const heading = document.createElement("h3");
        heading.textContent = group.team;
        section.append(heading);
        for (const player of group.players) {
            const status = getPickStatus(player.picks?.[game.id], game);
            const picker = document.createElement("button");
            picker.type = "button";
            picker.className = `game-picker ${status.className}`;
            picker.dataset.targetKind = "player";
            picker.dataset.targetId = player.id;
            picker.textContent = `${status.icon} ${displayName(player)}`;
            section.append(picker);
        }
        if (group.players.length === 0) {
            const empty = document.createElement("p");
            empty.className = "empty-pickers";
            empty.textContent = "No players";
            section.append(empty);
        }
        inner.append(section);
    }
    body.append(inner);
    card.append(summary, body);
    return card;
}
