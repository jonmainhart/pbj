"use strict";

let activePlayerCard = null;
let activeCardOverlay = null;
let onClose = () => closeActivePlayerCard(true);

export function initializePlayerCardInteractions(close = onClose) {
    onClose = close;
    document.addEventListener("keydown", (event) => {
        if (!activeCardOverlay) return;
        if (event.key === "Escape") {
            event.preventDefault();
            onClose();
        } else if (event.key === "Tab") {
            const buttons = [...activeCardOverlay.querySelectorAll("button")];
            const first = buttons[0];
            const last = buttons.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
}

export function isPlayerCardOpen() {
    return activeCardOverlay !== null;
}

export function getActiveCardScroll() {
    return activeCardOverlay?.firstElementChild.scrollTop ?? 0;
}

export function openPlayerCard(sourceCard, options = {}) {
    closeActivePlayerCard();
    const close = options.onClose ?? onClose;
    const overlay = document.createElement("div");
    overlay.className = "player-card-overlay";
    const raisedCard = sourceCard.cloneNode(true);
    raisedCard.classList.remove("is-selected");
    raisedCard.setAttribute("role", "dialog");
    raisedCard.setAttribute("aria-modal", "true");
    raisedCard.setAttribute("aria-label", sourceCard.dataset.entityKind === "game" ? "Game details" : "Player details");
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
    overlay.addEventListener("click", close);
    overlay.append(raisedCard);
    document.body.append(overlay);
    activePlayerCard = sourceCard;
    activeCardOverlay = overlay;
    sourceCard.classList.add("is-selected");
    sourceCard.querySelector(".player-summary").setAttribute("aria-expanded", "true");
    document.body.classList.add("card-open");
    raisedSummary.focus({ preventScroll: true });
    raisedCard.scrollTop = options.cardScroll ?? 0;
}

export function closeActivePlayerCard(restoreFocus = false) {
    activeCardOverlay?.remove();
    if (activePlayerCard) {
        activePlayerCard.classList.remove("is-selected");
        const summary = activePlayerCard.querySelector(".player-summary");
        summary.setAttribute("aria-expanded", "false");
        if (restoreFocus) summary.focus({ preventScroll: true });
    }
    activePlayerCard = null;
    activeCardOverlay = null;
    document.body.classList.remove("card-open");
}
