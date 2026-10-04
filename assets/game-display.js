"use strict";

function formatKickoffTime(scheduledTime) {
    const kickoff = new Date(scheduledTime);

    if (Number.isNaN(kickoff.getTime())) {
        return "";
    }

    return new Intl.DateTimeFormat(
        undefined,
        {
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
        },
    ).format(kickoff);
}


export function formatGameDisplay(game) {
    const away = game.away.abbreviation;
    const home = game.home.abbreviation;

    if (game.status === "live") {
        return `${away} ${game.away_score} @ ${home} ${game.home_score} — Live`;
    }

    if (game.status === "final") {
        return `${away} ${game.away_score} @ ${home} ${game.home_score} — Final`;
    }

    const kickoff = formatKickoffTime(game.scheduled_time);

    return (
        `${away} @ ${home}`
        + (kickoff ? ` — ${kickoff}` : "")
    );
}

