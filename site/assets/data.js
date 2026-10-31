"use strict";


export async function fetchWeek(season, week) {
    const response = await fetch(
        `./data/${season}/week${formatWeek(week)}.json`,
        { cache: "no-store" },
    );

    if (!response.ok) {
        throw new Error(`Week ${week} is not available yet.`);
    }

    return response.json();
}


export async function fetchSeason(season) {
    const response = await fetch(
        `./data/${season}/season.json`,
        { cache: "no-store" },
    );

    if (!response.ok) {
        throw new Error(
            "Season standings are not available yet.",
        );
    }

    return response.json();
}

export async function fetchAvailableWeeks() {
    const response = await fetch("./data/available-weeks.json");

    if (!response.ok) {
        throw new Error("Available weeks could not be loaded.");
    }

    return response.json();
}

function formatWeek(week) {
    return String(week).padStart(2, "0");
}