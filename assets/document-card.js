import { loadDocument } from "./documents.js";
import { openForegroundCard, closeForegroundCard } from "./foreground-card.js";

export function initializeDocumentCards() {
    const definitions = {
        rules: { title: "Pool Rules", url: "./assets/documents/rules.html" },
        license: { title: "Apache 2.0", url: "./assets/documents/license.html" },
        "license-scope": { title: "Data & artwork terms", url: "./assets/documents/license-scope.html" },
    };
    document.querySelectorAll("[data-document]").forEach((trigger) => {
        trigger.addEventListener("click", () => {
            openDocumentCard(definitions[trigger.dataset.document], trigger);
        });
    });
}

export async function openDocumentCard({ title, url }, trigger) {
    const pageScroll = window.scrollY;
    const card = document.createElement("article");
    card.className = "player-card document-card";
    const header = document.createElement("header");
    header.className = "document-card-header";
    const heading = document.createElement("h1");
    heading.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "document-close";
    close.setAttribute("aria-label", "Close");
    const dismiss = () => {
        closeForegroundCard();
        window.scrollTo(0, pageScroll);
        trigger.focus({ preventScroll: true });
    };
    close.addEventListener("click", dismiss);
    header.append(heading, close);
    const content = document.createElement("div");
    content.className = "document-content";
    content.setAttribute("aria-live", "polite");
    content.textContent = "Loading…";
    card.append(header, content);
    openForegroundCard(card, { title, onClose: dismiss, initialFocus: close });

    try {
        const html = await loadDocument(url);
        // A detached card must never be reopened by a delayed response.
        if (!card.isConnected) return;
        // Assets are generated from trusted repository documents, not user input.
        content.innerHTML = html;
        const documentTitle = content.firstElementChild;
        if (documentTitle?.tagName === "H1") {
            heading.replaceWith(documentTitle);
        }
    } catch {
        if (!card.isConnected) return;
        content.setAttribute("role", "alert");
        content.textContent = "Unable to load document. Please close and try again.";
    }
}
