"use strict";

const REFRESH_INTERVAL_MS = 15 * 1000;

export function initializeAutoRefresh(refresh) {
  window.setInterval(() => {
    if (!document.hidden) {
      refresh();
    }
  }, REFRESH_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refresh();
    }
  });
}
