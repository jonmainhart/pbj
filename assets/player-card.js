"use strict";

import { openForegroundCard, closeForegroundCard } from "./foreground-card.js";
export { getActiveCardScroll } from "./foreground-card.js";

let activePlayerCard = null;
let onClose = () => closeActivePlayerCard(true);

export function initializePlayerCardInteractions(close = onClose) {
    onClose = close;
}

export function isPlayerCardOpen() {
    return activePlayerCard !== null;
}

export function openPlayerCard(sourceCard, options = {}) {
    closeActivePlayerCard();
    const close = options.onClose ?? onClose;
    const raisedCard = sourceCard.cloneNode(true);
    raisedCard.classList.remove("is-selected");
    const raisedSummary = raisedCard.querySelector(".player-summary");
    raisedSummary.setAttribute("aria-expanded", "true");

    // Delegation binds drill-down actions on the displayed clone; cloneNode
    // deliberately does not copy event listeners from the source card.
    raisedCard.addEventListener("click", (event) => {
        event.stopPropagation();
        const target = event.target.closest("[data-target-kind]");
        if (target) {
            options.onNavigate?.(target.dataset.targetKind, target.dataset.targetId);
        } else if (event.target.closest(".player-summary")) {
            close();
        }
    });
    sourceCard.classList.add("is-selected");
    sourceCard.querySelector(".player-summary").setAttribute("aria-expanded", "true");
    openForegroundCard(raisedCard, {
        title: sourceCard.dataset.entityKind === "game" ? "Game details" : "Player details",
        onClose: close,
        initialFocus: raisedSummary,
        cardScroll: options.cardScroll ?? 0,
        onDispose: () => {
            sourceCard.classList.remove("is-selected");
            sourceCard.querySelector(".player-summary").setAttribute("aria-expanded", "false");
            activePlayerCard = null;
        },
    });
    activePlayerCard = sourceCard;
}

export function closeActivePlayerCard(restoreFocus = false) {
    if (!activePlayerCard) return;
    const source = activePlayerCard;
    closeForegroundCard();
    if (restoreFocus) source?.querySelector(".player-summary").focus({ preventScroll: true });
}
