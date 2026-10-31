"use strict";

export async function loadAnnouncements() {
    await Promise.all([
        loadAnnouncement(
            "./assets/announcement-top.txt",
            "#announcement-top",
        ),
        loadAnnouncement(
            "./assets/announcement-bottom.txt",
            "#announcement-bottom",
        ),
    ]);
}


async function loadAnnouncement(path, selector) {
    const element = document.querySelector(selector);

    try {
        const response = await fetch(
            path,
            { cache: "no-store" },
        );

        if (!response.ok) {
            element.hidden = true;
            return;
        }

        const text = (await response.text()).trim();

        if (!text) {
            element.hidden = true;
            element.textContent = "";
            return;
        }

        element.textContent = text;
        element.hidden = false;
    } catch {
        element.hidden = true;
        element.textContent = "";
    }
}