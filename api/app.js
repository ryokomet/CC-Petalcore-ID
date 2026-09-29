const MAX_SOURCE_BYTES = 20_000_000;
const MAX_UPLOAD_BYTES = 4_000_000;
const MAX_SOURCE_PIXELS = 25_000_000;
const $ = (id) => document.getElementById(id);
let selectedPhoto = null;
let previewUrl = null;
let busy = false;
let selectionVersion = 0;
let apiConfig = null;

function showError(message = "") {
    $("errorMessage").textContent = message;
    $("errorMessage").hidden = !message;
}

function showResultState(state) {
    for (const id of ["emptyState", "loadingState", "noMatchState", "results"]) {
        $(id).hidden = id !== state;
    }
    $("resultNote").hidden = state !== "results";
    document.querySelector(".results-panel").setAttribute("aria-busy", String(state === "loadingState"));
}

function setBusy(value) {
    busy = value;
    for (const id of ["chooseButton", "cameraButton", "removeButton", "organ"]) $(id).disabled = value;
    $("identifyButton").disabled = value || !selectedPhoto;
    $("buttonLabel").textContent = value ? "Identifying…" : "Identify this plant";
}

function resetPhoto() {
    selectionVersion++;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    selectedPhoto = null;
    $("preview").removeAttribute("src");
    $("preview").hidden = true;
    $("uploadPrompt").hidden = false;
    $("photoMeta").hidden = true;
    $("removeButton").hidden = true;
    $("photoInput").value = "";
    $("cameraInput").value = "";
    $("statusMessage").textContent = "";
    $("results").replaceChildren();
    showError();
    showResultState("emptyState");
    setBusy(false);
}

async function preparePhoto(file) {
    if (!["image/jpeg", "image/png"].includes(file.type)) {
        throw new Error("Please choose a JPG or PNG photo. Convert HEIC photos to JPG first.");
    }
    if (!file.size || file.size > MAX_SOURCE_BYTES) throw new Error("Choose a photo smaller than 20 MB.");
    const localUrl = URL.createObjectURL(file);
    const photo = new Image();
    try {
        photo.src = localUrl;
        await photo.decode();
        if (photo.naturalWidth * photo.naturalHeight > MAX_SOURCE_PIXELS) {
            throw new Error("This photo has very large dimensions. Resize it to 25 megapixels or less.");
        }
        const scale = Math.min(1, 2048 / Math.max(photo.naturalWidth, photo.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(photo.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(photo.naturalHeight * scale));
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(photo, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
        if (!blob || blob.size > MAX_UPLOAD_BYTES) throw new Error("This photo is still too large. Try a smaller photo.");
        return blob;
    } finally {
        URL.revokeObjectURL(localUrl);
    }
}

async function selectPhoto(file) {
    if (!file || busy) return;
    resetPhoto();
    const version = selectionVersion;
    $("statusMessage").textContent = "Preparing your photo…";
    try {
        const prepared = await preparePhoto(file);
        if (version !== selectionVersion) return;
        selectedPhoto = prepared;
        previewUrl = URL.createObjectURL(prepared);
        $("preview").src = previewUrl;
        $("preview").hidden = false;
        $("uploadPrompt").hidden = true;
        $("photoMeta").textContent = `${file.name} · ${(prepared.size / 1000).toFixed(0)} KB ready to upload`;
        $("photoMeta").hidden = false;
        $("removeButton").hidden = false;
        $("statusMessage").textContent = "Photo ready. Choose a plant part or let us detect it.";
        setBusy(false);
    } catch (error) {
        if (version !== selectionVersion) return;
        $("statusMessage").textContent = "";
        showError(error.name === "EncodingError" ? "This photo could not be opened. Try another JPG or PNG." : error.message);
    }
}

async function getConfig(signal) {
    if (apiConfig) return apiConfig;
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
    // Same-origin in production; local FastAPI fallback for VS Code Live Server.
    const origins = [...new Set([window.location.origin,
        ...(isLocal ? ["http://127.0.0.1:8012", "http://127.0.0.1:8000"] : [])])];
    for (const origin of origins) {
        if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
        const attempt = new AbortController();
        const cancel = () => attempt.abort();
        signal.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(cancel, 3000);
        try {
            const response = await fetch(`${origin}/config`, { signal: attempt.signal, cache: "no-store" });
            if (!response.ok) continue;
            const config = await response.json();
            if (typeof config.api_url !== "string" || typeof config.api_key !== "string") continue;
            // Relative API paths belong to the backend, not the Live Server origin.
            apiConfig = { ...config, api_url: new URL(config.api_url, `${origin}/`).href };
            return apiConfig;
        } catch (error) {
            if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
        }
    }
    throw new Error(isLocal
        ? "Could not connect to FastAPI. Start the backend on port 8012 or 8000, then try again."
        : "The site configuration could not be loaded. Please refresh and try again.");
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

function displayResults(matches) {
    $("results").replaceChildren();
    if (!matches.length) {
        showResultState("noMatchState");
        return;
    }
    matches.forEach((plant, index) => {
        const percent = Math.min(100, Math.max(0, plant.score * 100));
        const card = element("article", "match-card", "");
        const topline = element("div", "match-topline", "");
        topline.append(element("span", "", index === 0 ? "Closest match" : `Possible match ${index + 1}`), element("span", "", `${percent.toFixed(1)}% match score`));
        const name = plant.common_names[0] || plant.scientific_name;
        card.append(topline, element("h4", "", name), element("p", "scientific-name", plant.scientific_name));
        const meta = element("div", "match-meta", "");
        meta.append(element("span", "", `Family: ${plant.family || "Not provided"}`), element("span", "", `Genus: ${plant.genus || "Not provided"}`));
        const track = element("div", "score-track", "");
        track.setAttribute("aria-hidden", "true");
        const fill = element("div", "score-fill", "");
        fill.style.width = `${percent}%`;
        track.append(fill);
        card.append(meta, track);
        $("results").append(card);
    });
    showResultState("results");
}

$("identifyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedPhoto || busy) return;
    showError();
    setBusy(true);
    showResultState("loadingState");
    $("statusMessage").textContent = "Your photo is being identified…";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
        const config = await getConfig(controller.signal);
        const body = new FormData();
        body.append("image", selectedPhoto, "plant.jpg");
        body.append("organ", $("organ").value);
        const response = await fetch(`${config.api_url.replace(/\/$/, "")}/identify`, {
            method: "POST", headers: { "x-api-key": config.api_key }, body, signal: controller.signal
        });
        let data;
        try { data = await response.json(); } catch { throw new Error("The server returned an unexpected response. Please try again."); }
        if (!response.ok) {
            throw new Error(typeof data.detail === "string" ? data.detail : "The photo could not be submitted. Check your image and try again.");
        }
        displayResults(data.results);
        $("statusMessage").textContent = data.count ? `Found ${data.count} possible ${data.count === 1 ? "match" : "matches"}.` : "No match found. Try a clearer photo.";
    } catch (error) {
        showResultState("emptyState");
        $("statusMessage").textContent = "";
        showError(error.name === "AbortError" ? "This request took too long. Please try again." : error instanceof TypeError ? "Could not connect. Check your connection and try again." : error.message);
    } finally {
        clearTimeout(timer);
        setBusy(false);
    }
});

$("chooseButton").addEventListener("click", () => $("photoInput").click());
$("cameraButton").addEventListener("click", () => $("cameraInput").click());
for (const id of ["photoInput", "cameraInput"]) $(id).addEventListener("change", (event) => selectPhoto(event.target.files[0]));
$("removeButton").addEventListener("click", resetPhoto);
for (const name of ["dragenter", "dragover"]) $("dropZone").addEventListener(name, (event) => {
    event.preventDefault();
    if (!busy) $("dropZone").classList.add("drag-over");
});
for (const name of ["dragleave", "drop"]) $("dropZone").addEventListener(name, (event) => {
    event.preventDefault();
    $("dropZone").classList.remove("drag-over");
});
$("dropZone").addEventListener("drop", (event) => {
    if (busy) return;
    if (event.dataTransfer.files.length !== 1) {
        showError("Please choose one photo of one plant at a time.");
        return;
    }
    selectPhoto(event.dataTransfer.files[0]);
});
