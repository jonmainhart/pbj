export function orderGames(games) {
    return [...games].sort((left, right) =>
        Number(left.status === "final") - Number(right.status === "final")
        || new Date(left.scheduled_time) - new Date(right.scheduled_time),
    );
}

export function groupGamePicks(game, players) {
    const groups = [game.away.abbreviation, game.home.abbreviation, "N/P"]
        .map((team) => ({ team, players: [] }));
    for (const player of players) {
        const pick = player.picks?.[game.id] ?? "N/P";
        groups.find((group) => group.team === pick)?.players.push(player);
    }
    return groups;
}
