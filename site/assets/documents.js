export async function loadDocument(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load document.");
    return response.text();
}
