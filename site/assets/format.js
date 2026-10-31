"use strict";


export function formatAccuracy(value) {
    if (
        value === null
        || value === undefined
    ) {
        return "—";
    }

    return `${Math.round(value * 1000) / 10}`;
}