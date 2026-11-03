"use strict";

export function renderAnnouncement(element, item) {
    if (!element) return;
    element.replaceChildren();
    element.hidden = true;
    if (!item || typeof item.text !== 'string' || !item.text.trim()) return;
    element.append(document.createTextNode(item.text.trim()));
    const link = item.link;
    if (link && typeof link.label === 'string' && link.label.trim() && typeof link.url === 'string') {
        try {
            const url = new URL(link.url);
            if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
                const anchor = document.createElement('a');
                anchor.href = url.href;
                anchor.textContent = link.label.trim();
                element.append(document.createTextNode(' '), anchor);
            }
        } catch { /* Invalid links do not hide otherwise usable text. */ }
    }
    element.hidden = false;
}
let pending;
export function loadAnnouncements() {
    if (!document.getElementById('announcement-top')) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
        let data;
        try {
            const response = await fetch('/data/announcements.json', {cache:'no-store'});
            if (response.ok) data = await response.json();
        } catch { /* Announcements must not block the dashboard. */ }
        for (const position of ['top', 'bottom']) {
            renderAnnouncement(document.getElementById('announcement-' + position), data?.[position]);
        }
    })().finally(() => { pending = null; });
    return pending;
}
let suspended = false;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspended = true;
    else if (suspended) { suspended = false; void loadAnnouncements(); }
});
window.addEventListener('pageshow', event => { if (event.persisted) void loadAnnouncements(); });
