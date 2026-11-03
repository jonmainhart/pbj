"use strict";

const playerNameMap = new Map();
const playerNameWeeks = new Map();


export function rememberPlayerNames(players, week = 0) {
    for (const player of players) {
        if ((playerNameWeeks.get(player.id) ?? -1) > week) continue;
        playerNameWeeks.set(player.id, week);
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

/** Search newest first; stop when every season participant has an authoritative name. */
export async function loadSeasonPlayerNames(players, weeks, fetchWeek) {
    const unresolved = new Set(players.map(player => player.player_id));
    for (const week of [...new Set(weeks)].sort((a, b) => b - a)) {
        for (const id of unresolved) {
            if ((playerNameWeeks.get(id) ?? -1) >= week) unresolved.delete(id);
        }
        if (!unresolved.size) break;
        try {
            const data = await fetchWeek(week);
            rememberPlayerNames(data.players ?? [], week);
            for (const player of data.players ?? []) unresolved.delete(player.id);
        } catch {
            // Retain known names and continue looking for historical participants.
        }
    }
}
