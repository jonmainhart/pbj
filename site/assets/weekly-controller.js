import { openEntity, crossNavigate, closeEntity } from "./weekly-navigation.js";
import {
    initializePlayerCardInteractions,
    openPlayerCard,
    closeActivePlayerCard,
    getActiveCardScroll,
    isPlayerCardOpen,
} from "./player-card.js";

let state = { view: "players", active: null, returnTo: null };

export function initializeWeeklyInteractions() {
    initializePlayerCardInteractions(closeCard);
    for (const view of ["players", "games"]) {
        document.querySelector(`#${view}-toggle`).addEventListener("click", () => {
            resetWeeklyNavigation(view);
        });
    }
    document.addEventListener("click", (event) => {
        const button = event.target.closest("[data-open-kind]");
        if (!button || button.closest(".player-card-overlay")) return;
        const target = snapshot(button.dataset.openKind, button.dataset.openId);
        state = openEntity(state, target);
        showActiveCard();
    });
}

export function isWeeklyCardOpen() {
    return isPlayerCardOpen();
}

export function resetWeeklyNavigation(view = state.view) {
    closeActivePlayerCard();
    state = { view, active: null, returnTo: null };
    showWeeklyPresentation();
}

function snapshot(kind, id) {
    return { kind, id, pageScroll: window.scrollY, cardScroll: 0 };
}

function findCard(entity) {
    const container = document.querySelector(entity.kind === "player" ? "#player-list" : "#game-list");
    return [...container.children].find((card) => card.dataset.entityId === entity.id);
}

function navigate(kind, id) {
    const origin = { ...state.active, cardScroll: getActiveCardScroll(), pageScroll: window.scrollY };
    closeActivePlayerCard();
    state = crossNavigate({ ...state, active: origin }, snapshot(kind, id));
    showWeeklyPresentation();
    const card = findCard(state.active);
    card.querySelector(".player-summary").scrollIntoView({ block: "nearest" });
    state = { ...state, active: { ...state.active, pageScroll: window.scrollY } };
    showActiveCard();
}

function closeCard() {
    const previous = state.active;
    closeActivePlayerCard();
    state = closeEntity(state);
    showWeeklyPresentation();
    if (state.active) {
        showActiveCard();
    } else if (previous) {
        window.scrollTo(0, previous.pageScroll);
        findCard(previous)?.querySelector(".player-summary").focus({ preventScroll: true });
    }
}

function showActiveCard() {
    showWeeklyPresentation();
    const card = findCard(state.active);
    if (!card) {
        resetWeeklyNavigation();
        return;
    }
    openPlayerCard(card, {
        onClose: closeCard,
        onNavigate: navigate,
        cardScroll: state.active.cardScroll,
    });
    window.scrollTo(0, state.active.pageScroll);
}

function showWeeklyPresentation() {
    for (const view of ["players", "games"]) {
        const selected = state.view === view;
        document.querySelector(`#${view}-toggle`).setAttribute("aria-pressed", String(selected));
        document.querySelector(view === "players" ? "#player-list" : "#game-list").hidden = !selected;
    }
    document.querySelector("#weekly-list-heading").textContent = state.view === "players" ? "Players" : "Games";
}
