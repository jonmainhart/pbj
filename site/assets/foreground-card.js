let active = null;
let initialized = false;

export function isForegroundCardOpen() {
    return active !== null;
}

export function getActiveCardScroll() {
    return active?.card.scrollTop ?? 0;
}

export function closeForegroundCard() {
    if (!active) return;
    const previous = active;
    active = null;
    previous.overlay.remove();
    previous.onDispose?.();
    document.body.classList.remove("card-open");
}

export function openForegroundCard(card, { title, onClose, onDispose, initialFocus, cardScroll = 0 }) {
    closeForegroundCard();
    initializeKeyboardInteractions();
    const overlay = document.createElement("div");
    overlay.className = "foreground-card-overlay player-card-overlay";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", title);
    card.tabIndex = -1;
    const close = onClose ?? closeForegroundCard;
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close();
    });
    overlay.append(card);
    document.body.append(overlay);
    active = { card, overlay, onClose: close, onDispose };
    document.body.classList.add("card-open");
    (initialFocus ?? card).focus({ preventScroll: true });
    card.scrollTop = cardScroll;
}

function initializeKeyboardInteractions() {
    if (initialized) return;
    initialized = true;
    document.addEventListener("keydown", (event) => {
        if (!active) return;
        if (event.key === "Escape") {
            event.preventDefault();
            active.onClose();
        } else if (event.key === "Tab") {
            const controls = [...active.card.querySelectorAll(
                'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), '
                + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            )].filter((control) => control.tabIndex >= 0 && control.getClientRects().length > 0);
            const first = controls[0] ?? active.card;
            const last = controls.at(-1) ?? active.card;
            const outside = !active.card.contains(document.activeElement);
            if (event.shiftKey && (document.activeElement === first || outside)) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            } else if (!event.shiftKey && (document.activeElement === last || outside)) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            }
        }
    });
}
