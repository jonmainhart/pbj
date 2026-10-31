"use strict";

const playerNameMap = new Map();


export function rememberPlayerNames(players) {
    for (const player of players) {
        playerNameMap.set(
            player.id,
            displayName(player),
        );
    }
}


export function getPlayerName(playerId) {
    return (
        playerNameMap.get(playerId)
        ?? humanizePlayerId(playerId)
    );
}


export function displayName(player) {
    return player.nickname || player.name;
}


function humanizePlayerId(playerId) {
    return playerId
        .split("-")
        .map(
            (part) =>
                part.charAt(0).toUpperCase()
                + part.slice(1),
        )
        .join(" ");
}