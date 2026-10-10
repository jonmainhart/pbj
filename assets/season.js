"use strict";

import { formatAccuracy } from "./format.js";

export function renderSeason(data, getPlayerName) {
    const container = document.querySelector("#season-list");
    container.replaceChildren();

    if (!data.players?.length) {
        setText(
            "#season-message",
            "No completed weeks yet.",
        );

        return;
    }

    setText(
        "#season-message",
        `${data.weeks_scored.length} completed week(s).`,
    );

    const players = [...data.players].sort(
        compareSeasonPlayers,
    );

    let previousWins = null;
    let previousAccuracy = null;
    let previousRank = 0;

    players.forEach((player, index) => {
        const position = index + 1;

        if (
            player.wins !== previousWins
            || player.accuracy !== previousAccuracy
        ) {
            previousRank = position;
            previousWins = player.wins;
            previousAccuracy = player.accuracy;
        }

        container.append(
            createSeasonCard(
                player,
                previousRank,
                getPlayerName,
            ),
        );
    });
}


function createSeasonCard(player, position, getPlayerName) {
    const card = document.createElement("div");
    card.className = "season-card";

    const left = document.createElement("div");
    left.className = "season-left";

    const name = document.createElement("div");
    name.className = "season-name";

    const crown =
        position === 1
            ? "👑 "
            : "";

    name.textContent =
        `${crown}${position}. ${getPlayerName(player.player_id)}`;

    const record = document.createElement("div");
    record.className = "season-record";
    record.textContent =
        `${player.wins}-${player.losses}-${player.ties}`;

    const meta = document.createElement("div");
    meta.className = "season-meta";

    const missedPicks = player.missed_picks ?? 0;

    meta.textContent =
        `Weeks played: ${player.weeks_played}`
        + ` • Missed picks: ${missedPicks}`;

    left.append(name, record, meta);

    const right = document.createElement("div");
    right.className = "season-right";

    const accuracy = document.createElement("div");
    accuracy.className = "season-accuracy";
    accuracy.textContent =
        `Win % ${formatAccuracy(player.accuracy)}`;

    const finishIndicators = document.createElement("div");
    finishIndicators.className = "weekly-wins";

    const indicators = [
        `🏆 ${player.weekly_wins}`,
    ];

    const lastPlaceFinishes =
        player.last_place_finishes ?? 0;

    if (lastPlaceFinishes > 0) {
        indicators.push(`💩 ${lastPlaceFinishes}`);
    }

    finishIndicators.textContent =
        indicators.join(" • ");

    right.append(
        accuracy,
        finishIndicators,
    );

    card.append(left, right);

    return card;
}


function compareSeasonPlayers(left, right) {
    if (left.wins !== right.wins) {
        return right.wins - left.wins;
    }

    const leftAccuracy = left.accuracy ?? -1;
    const rightAccuracy = right.accuracy ?? -1;

    return rightAccuracy - leftAccuracy;
}


function setText(selector, text) {
    const element = document.querySelector(selector);

    element.textContent = text;
}
