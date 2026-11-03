"use strict";


const weeklyRequests = new Map();

export function fetchWeek(season, week, {reuse = false} = {}) {
    const key = `${season}/${week}`;
    if (reuse && weeklyRequests.has(key)) return weeklyRequests.get(key);
    const request = requestWeek(season, week);
    weeklyRequests.set(key, request);
    request.catch(() => { if (weeklyRequests.get(key) === request) weeklyRequests.delete(key); });
    return request;
}

async function requestWeek(season, week) {
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
    const response = await fetch("./data/available-weeks.json", { cache: "no-store" });

    if (!response.ok) {
        throw new Error("Available weeks could not be loaded.");
    }

    return response.json();
}

function formatWeek(week) {
    return String(week).padStart(2, "0");
}