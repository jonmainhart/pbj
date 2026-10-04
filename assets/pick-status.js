"use strict";

export function getPickStatus(pick, game) {
    if (!pick) {
        if (game.status === "final") {
            return {
                icon: "❌",
                className: "pick-wrong",
            };
        }

        return {
            icon: "⏳",
            className: "pick-pending",
        };
    }

    if (game.status === "live") {
        const pickedAway =
            pick === game.away.abbreviation;

        const pickedScore =
            pickedAway
                ? game.away_score
                : game.home_score;

        const opponentScore =
            pickedAway
                ? game.home_score
                : game.away_score;

        if (
            pickedScore !== null
            && opponentScore !== null
            && pickedScore < opponentScore
        ) {
            return {
                icon: "🟡",
                className: "pick-live-losing",
            };
        }

        return {
            icon: "🟢",
            className: "pick-live",
        };
    }

    if (game.status !== "final") {
        return {
            icon: "⏳",
            className: "pick-pending",
        };
    }

    if (
        game.away_score === null
        || game.home_score === null
    ) {
        return {
            icon: "⏳",
            className: "pick-pending",
        };
    }

    if (game.away_score === game.home_score) {
        return {
            icon: "➖",
            className: "pick-tie",
        };
    }

    const winner =
        game.away_score > game.home_score
            ? game.away.abbreviation
            : game.home.abbreviation;

    if (pick === winner) {
        return {
            icon: "✅",
            className: "pick-correct",
        };
    }

    return {
        icon: "❌",
        className: "pick-wrong",
    };
}

