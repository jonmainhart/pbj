"use strict";

import {
    closeActivePlayerCard,
} from "./player-card.js";

import { displayName } from "./players.js";

import { formatAccuracy } from "./format.js";
import { getPickStatus } from "./pick-status.js";
import { formatGameDisplay } from "./game-display.js";
import { renderGames } from "./games.js";

export function renderWeeklyView(data, getPlayerName) {
    const results = data.results ?? null;
    const players = data.players ?? [];
    const games = data.games ?? [];

    const complete = isWeekComplete(data);

    setText(
        "#week-status",
        complete
            ? `Week ${data.week} Final`
            : `Week ${data.week} In Progress`,
    );

    renderWeeklySummary(data, getPlayerName);
    renderPlayers(players, games, results);
    renderGames(games, players);
}


function renderWeeklySummary(data, getPlayerName) {
    const container = document.querySelector("#weekly-summary");
    const results = data.results;

    container.replaceChildren();

    const playerCount =
        results?.player_count
        ?? data.players?.length
        ?? 0;

    const finalGames =
        data.games?.filter(
            (game) => game.status === "final",
        ).length
        ?? 0;

    const totalGames = data.games?.length ?? 0;

    const winnerText =
        results?.weekly_winners?.length > 0
            ? results.weekly_winners
                .map((id) => getPlayerName(id))
                .join(", ")
            : "TBD";

    const mondayTotal =
        results?.monday_total
        ?? "TBD";

    container.append(
        createSummaryCard(
            String(playerCount),
            "Players",
        ),
        createSummaryCard(
            `${finalGames}/${totalGames}`,
            "Games Final",
        ),
        createSummaryCard(
            winnerText,
            "Winner",
        ),
        createSummaryCard(
            String(mondayTotal),
            "Monday Total",
        ),
    );
}


function createSummaryCard(value, label) {
    const card = document.createElement("div");
    card.className = "summary-card";

    const valueElement = document.createElement("span");
    valueElement.className = "summary-value";
    valueElement.textContent = value;

    const labelElement = document.createElement("span");
    labelElement.className = "summary-label";
    labelElement.textContent = label;

    card.append(valueElement, labelElement);

    return card;
}


function renderPlayers(players, games, results) {
    closeActivePlayerCard();

    const container = document.querySelector("#player-list");
    container.replaceChildren();

    const playersById = new Map(
        players.map((player) => [
            player.id,
            player,
        ]),
    );

    const resultPlayers =
        results?.players
        ?? players.map((player) => ({
            player_id: player.id,
            wins: 0,
            losses: 0,
            ties: 0,
            missed_picks: 0,
            accuracy: null,
            tiebreaker_distance: null,
            weekly_rank: null,
            weekly_winner: false,
        }));

    const completedRanks = resultPlayers
        .map((result) => result.weekly_rank)
        .filter((rank) => rank !== null);

    const lastPlaceRank =
        completedRanks.length > 0
            ? Math.max(...completedRanks)
            : null;

    const eliminatedPlayerIds = identifyEliminatedPlayers(
        players,
        games,
        resultPlayers,
    );

    const sortedResults = [...resultPlayers].sort(
        (left, right) =>
            compareWeeklyResults(
                left,
                right,
                eliminatedPlayerIds,
            ),
    );

    let eliminatedDividerAdded = false;

    for (const result of sortedResults) {
        const player = playersById.get(result.player_id);

        if (!player) {
            continue;
        }

        if (
            !eliminatedDividerAdded
            && eliminatedPlayerIds.has(result.player_id)
        ) {
            container.append(createEliminatedDivider());
            eliminatedDividerAdded = true;
        }

        container.append(
            createPlayerCard(
                player,
                result,
                games,
                lastPlaceRank !== null
                    && result.weekly_rank === lastPlaceRank,
            ),
        );
    }
}


function identifyEliminatedPlayers(
    players,
    games,
    resultPlayers,
) {
    const unfinishedGames = games.filter(
        (game) => game.status !== "final",
    );

    if (unfinishedGames.length === 0) {
        return new Set();
    }

    const playerIndexes = new Map(
        resultPlayers.map((result, index) => [
            result.player_id,
            index,
        ]),
    );

    const wins = resultPlayers.map(
        (result) => result.wins,
    );

    const remainingPicks = unfinishedGames.map((game) => {
        const awayPickers = [];
        const homePickers = [];

        for (const player of players) {
            const playerIndex = playerIndexes.get(player.id);

            if (playerIndex === undefined) {
                continue;
            }

            const pick = player.picks?.[game.id];

            if (pick === game.away.abbreviation) {
                awayPickers.push(playerIndex);
            } else if (pick === game.home.abbreviation) {
                homePickers.push(playerIndex);
            }
        }

        return {
            awayPickers,
            homePickers,
        };
    });

    const alivePlayerIndexes = new Set();

    function explore(gameIndex) {
        if (alivePlayerIndexes.size === resultPlayers.length) {
            return;
        }

        if (gameIndex === remainingPicks.length) {
            const highestWins = Math.max(...wins);

            wins.forEach((playerWins, playerIndex) => {
                if (playerWins === highestWins) {
                    alivePlayerIndexes.add(playerIndex);
                }
            });

            return;
        }

            const game = remainingPicks[gameIndex];

            for (const playerIndex of game.awayPickers) {
                wins[playerIndex] += 1;
            }

            explore(gameIndex + 1);

            for (const playerIndex of game.awayPickers) {
                wins[playerIndex] -= 1;
            }

            for (const playerIndex of game.homePickers) {
                wins[playerIndex] += 1;
            }

            explore(gameIndex + 1);

            for (const playerIndex of game.homePickers) {
                wins[playerIndex] -= 1;
            }
        }

    explore(0);

    return new Set(
        resultPlayers
            .filter(
                (_, index) => !alivePlayerIndexes.has(index),
            )
            .map((result) => result.player_id),
    );
}


function compareWeeklyResults(
    left,
    right,
    eliminatedPlayerIds,
) {
    if (
        left.weekly_rank !== null
        && right.weekly_rank !== null
    ) {
        return left.weekly_rank - right.weekly_rank;
    }

    const leftEliminated =
        eliminatedPlayerIds.has(left.player_id);

    const rightEliminated =
        eliminatedPlayerIds.has(right.player_id);

    if (leftEliminated !== rightEliminated) {
        return leftEliminated ? 1 : -1;
    }

    return right.wins - left.wins;
}


function createPlayerCard(
    player,
    result,
    games,
    isLastPlace,
) {
    const card = document.createElement("article");
    card.className = "player-card";
    card.dataset.entityKind = "player";
    card.dataset.entityId = player.id;

    const summary = document.createElement("button");
    summary.className = "player-summary";
    summary.type = "button";

    summary.setAttribute("aria-expanded", "false");

    const nameBlock = document.createElement("div");
    nameBlock.className = "player-summary-name";

    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = displayName(player);

    if (result.weekly_winner) {
        name.textContent = `🏆 ${name.textContent}`;
    }

    if (isLastPlace) {
        name.textContent = `💩 ${name.textContent}`;
    }

    const rank =
        result.weekly_rank !== null
        && !result.weekly_winner
        && !isLastPlace
            ? `${formatRank(result.weekly_rank)} · `
            : "";

    name.textContent = `${rank}${name.textContent}`;

    const accuracy = document.createElement("div");
    accuracy.className = "player-accuracy";
    accuracy.textContent =
        `Win %: ${formatAccuracy(result.accuracy)}`;

    nameBlock.append(name, accuracy);

    const right = document.createElement("div");
    right.className = "player-summary-right";

    const record = document.createElement("span");
    record.className = "player-record";
    record.textContent =
        `${result.wins}-${result.losses}-${result.ties}`;

    right.append(record);

    summary.append(nameBlock, right);

    const body = document.createElement("div");
    body.className = "player-details";

    const bodyInner = document.createElement("div");
    bodyInner.className = "player-details-inner";

    bodyInner.append(
        createPlayerDetailGrid(
            player,
            result,
        ),
        createPickList(
            player,
            games,
        ),
    );

    body.append(bodyInner);

    summary.dataset.openKind = "player";
    summary.dataset.openId = player.id;

    const compactPicks = document.createElement("div");
    compactPicks.className = "compact-picks";
    compactPicks.setAttribute("role", "list");
    compactPicks.setAttribute("aria-label", "Picks in game order");
    for (const game of games) {
        const pick = createPickValue(player.picks?.[game.id], game);
        pick.setAttribute("role", "listitem");
        pick.setAttribute("aria-label", `${formatGameDisplay(game)}: ${pick.textContent}`);
        compactPicks.append(pick);
    }

    summary.append(compactPicks);
    card.append(summary, body);

    return card;
}


function createPlayerDetailGrid(player, result) {
    const grid = document.createElement("div");
    grid.className = "detail-grid";

    grid.append(
        createDetailBox(
            result.weekly_rank ?? "—",
            "Weekly Rank",
        ),
        createDetailBox(
            player.tiebreaker,
            "Tiebreaker Pick",
        ),
        createDetailBox(
            result.tiebreaker_distance ?? "—",
            "Tiebreaker Distance",
        ),
        createDetailBox(
            formatAccuracy(result.accuracy),
            "Win %",
        ),
        createDetailBox(
            result.missed_picks ?? 0,
            "Missed Picks",
        ),
    );

    return grid;
}


function createDetailBox(value, label) {
    const box = document.createElement("div");
    box.className = "detail-box";

    const valueElement = document.createElement("span");
    valueElement.className = "detail-value";
    valueElement.textContent = String(value);

    const labelElement = document.createElement("span");
    labelElement.className = "detail-label";
    labelElement.textContent = label;

    box.append(valueElement, labelElement);

    return box;
}

function createEliminatedDivider() {
    const divider = document.createElement("div");
    divider.className = "eliminated-divider";
    divider.textContent = "Eliminated";

    return divider;
}




function createPickList(player, games) {
    const list = document.createElement("div");
    list.className = "pick-list";

    for (const game of games) {
        const row = document.createElement("div");
        row.className = "pick-row";

        const gameName = document.createElement("button");
        gameName.type = "button";
        gameName.dataset.targetKind = "game";
        gameName.dataset.targetId = game.id;
        gameName.className = "game-name";

        gameName.textContent = formatGameDisplay(game);

        const pick = createPickValue(player.picks?.[game.id], game);

        row.append(gameName, pick);
        list.append(row);
    }

    return list;
}

function createPickValue(pickValue, game) {
    const pick = document.createElement("div");
    const status = getPickStatus(pickValue, game);
    pick.className = `pick-value ${status.className}`;

    const statusIcon = document.createElement("span");
    statusIcon.className = "pick-status";
    statusIcon.textContent = status.icon;

    const teamPick = document.createElement("span");
    teamPick.className = "pick-team";
    teamPick.textContent = pickValue ?? "N/P";

    pick.append(statusIcon, teamPick);
    return pick;
}




function isWeekComplete(data) {
    const games = data.games ?? [];

    return (
        games.length > 0
        && games.every(
            (game) => game.status === "final",
        )
    );
}


function setText(selector, text) {
    const element = document.querySelector(selector);

    element.textContent = text;
}


function formatRank(rank) {
    const remainder = rank % 100;

    if (remainder >= 11 && remainder <= 13) {
        return `${rank}th`;
    }

    switch (rank % 10) {
        case 1:
            return `${rank}st`;
        case 2:
            return `${rank}nd`;
        case 3:
            return `${rank}rd`;
        default:
            return `${rank}th`;
    }
}
