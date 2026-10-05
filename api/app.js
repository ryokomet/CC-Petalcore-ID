const MAX_SOURCE_BYTES = 20_000_000;
const MAX_UPLOAD_BYTES = 4_000_000;
const MAX_SOURCE_PIXELS = 25_000_000;
const API_CONFIG_TIMEOUT_MS = 3000;
const LOCAL_API_ORIGINS = ["http://127.0.0.1:8012", "http://127.0.0.1:8000"];
const SHARED_API_ORIGIN = "https://ryokomet-cloudcomputing.vercel.app";
const $ = (id) => document.getElementById(id);

let selectedPhoto = null;
let previewUrl = null;
let busy = false;
let selectionVersion = 0;
let apiConfig = null;


// API CONFIGURATION
async function getAPIConfig(signal) {
    if (apiConfig) return apiConfig;

    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
    // Prefer same-origin configuration, then check local FastAPI during Live Server development.
    const origins = [...new Set([
        window.location.origin,
        ...(isLocal ? [SHARED_API_ORIGIN, ...LOCAL_API_ORIGINS] : [])
    ])];

    for (const origin of origins) {
        if (signal && signal.aborted) {
            throw new DOMException("Request cancelled", "AbortError");
        }

        const attempt = new AbortController();
        const cancelAttempt = () => attempt.abort();
        if (signal) signal.addEventListener("abort", cancelAttempt, { once: true });
        const timer = setTimeout(cancelAttempt, API_CONFIG_TIMEOUT_MS);

        try {
            const response = await fetch(origin + "/config", {
                signal: attempt.signal,
                cache: "no-store"
            });
            if (!response.ok) continue;

            const config = await response.json();
            if (typeof config.api_url !== "string" || typeof config.api_key !== "string") continue;

            // Resolve relative API URLs against the server that provided this configuration.
            apiConfig = {
                ...config,
                api_url: new URL(config.api_url, origin + "/").href
            };
            return apiConfig;
        } catch (error) {
            if (signal && signal.aborted) {
                throw new DOMException("Request cancelled", "AbortError");
            }
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", cancelAttempt);
        }
    }

    throw new Error(isLocal
        ? "Could not connect to the shared Petalcore API. Check the Vercel API URL or start the local backend."
        : "The site configuration could not be loaded. Please refresh and try again.");
}


// API REQUEST HELPER
async function fetchAPI(endpoint, options = {}) {
    const config = await getAPIConfig(options.signal);
    const response = await fetch(
        config.api_url.replace(/\/$/, "") + endpoint,
        {
            method: options.method || "GET",
            headers: { "x-api-key": config.api_key },
            body: options.body,
            signal: options.signal
        }
    );

    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("The server returned an unexpected response. Please try again.");
    }

    if (!response.ok) {
        throw new Error(
            typeof data.detail === "string"
                ? data.detail
                : "The photo could not be submitted. Check your image and try again."
        );
    }

    return data;
}


// PAGE STATE
function showError(message = "") {
    $("errorMessage").textContent = message;
    $("errorMessage").hidden = !message;
}

function showResultState(state) {
    for (const id of ["emptyState", "loadingState", "noMatchState", "results"]) {
        $(id).hidden = id !== state;
    }
    $("resultNote").hidden = state !== "results";
    document.querySelector(".results-panel")
        .setAttribute("aria-busy", String(state === "loadingState"));
}

function setBusy(value) {
    busy = value;
    for (const id of ["chooseButton", "cameraButton", "removeButton", "organ"]) {
        $(id).disabled = value;
    }
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


// PHOTO UPLOAD
async function preparePhoto(file) {
    if (!["image/jpeg", "image/png"].includes(file.type)) {
        throw new Error("Please choose a JPG or PNG photo. Convert HEIC photos to JPG first.");
    }
    if (!file.size || file.size > MAX_SOURCE_BYTES) {
        throw new Error("Choose a photo smaller than 20 MB.");
    }

    const localUrl = URL.createObjectURL(file);
    const photo = new Image();

    try {
        photo.src = localUrl;
        await photo.decode();
        if (photo.naturalWidth * photo.naturalHeight > MAX_SOURCE_PIXELS) {
            throw new Error("This photo has very large dimensions. Resize it to 25 megapixels or less.");
        }

        const scale = Math.min(
            1,
            2048 / Math.max(photo.naturalWidth, photo.naturalHeight)
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(photo.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(photo.naturalHeight * scale));

        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(photo, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
        if (!blob || blob.size > MAX_UPLOAD_BYTES) {
            throw new Error("This photo is still too large. Try a smaller photo.");
        }
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
        const preparedPhoto = await preparePhoto(file);
        if (version !== selectionVersion) return;

        selectedPhoto = preparedPhoto;
        previewUrl = URL.createObjectURL(preparedPhoto);
        $("preview").src = previewUrl;
        $("preview").hidden = false;
        $("uploadPrompt").hidden = true;
        $("photoMeta").textContent =
            file.name + " · " + (preparedPhoto.size / 1000).toFixed(0) + " KB ready to upload";
        $("photoMeta").hidden = false;
        $("removeButton").hidden = false;
        $("statusMessage").textContent =
            "Photo ready. Choose a plant part or let us detect it.";
        setBusy(false);
    } catch (error) {
        if (version !== selectionVersion) return;
        $("statusMessage").textContent = "";
        showError(
            error.name === "EncodingError"
                ? "This photo could not be opened. Try another JPG or PNG."
                : error.message
        );
    }
}


// IDENTIFY A PLANT
async function identifyPlant(photo, organ, signal) {
    const body = new FormData();
    body.append("image", photo, "plant.jpg");
    body.append("organ", organ);

    return await fetchAPI("/identify", {
        method: "POST",
        body,
        signal
    });
}


// DISPLAY IDENTIFICATION RESULTS
function createElement(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

function displayResults(matches) {
    $("results").replaceChildren();
    if (!matches || matches.length === 0) {
        showResultState("noMatchState");
        return;
    }

    matches.forEach((plant, index) => {
        const percent = Math.min(100, Math.max(0, plant.score * 100));
        const card = createElement("article", "match-card", "");
        const topline = createElement("div", "match-topline", "");
        topline.append(
            createElement(
                "span",
                "",
                index === 0 ? "Closest match" : "Possible match " + (index + 1)
            ),
            createElement("span", "", percent.toFixed(1) + "% match score")
        );

        const name = plant.common_names[0] || plant.scientific_name;
        card.append(
            topline,
            createElement("h4", "", name),
            createElement("p", "scientific-name", plant.scientific_name)
        );

        const meta = createElement("div", "match-meta", "");
        meta.append(
            createElement("span", "", "Family: " + (plant.family || "Not provided")),
            createElement("span", "", "Genus: " + (plant.genus || "Not provided"))
        );

        const track = createElement("div", "score-track", "");
        track.setAttribute("aria-hidden", "true");
        const fill = createElement("div", "score-fill", "");
        fill.style.width = percent + "%";
        track.append(fill);
        card.append(meta, track);
        $("results").append(card);
    });

    showResultState("results");
}

async function handleIdentify(event) {
    event.preventDefault();
    if (!selectedPhoto || busy) return;

    showError();
    setBusy(true);
    showResultState("loadingState");
    $("statusMessage").textContent = "Your photo is being identified…";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);

    try {
        const data = await identifyPlant(
            selectedPhoto,
            $("organ").value,
            controller.signal
        );
        displayResults(data.results);
        $("statusMessage").textContent = data.count
            ? "Found " + data.count + " possible " + (data.count === 1 ? "match." : "matches.")
            : "No match found. Try a clearer photo.";
    } catch (error) {
        showResultState("emptyState");
        $("statusMessage").textContent = "";
        showError(
            error.name === "AbortError"
                ? "This request took too long. Please try again."
                : error instanceof TypeError
                    ? "Could not connect. Check your connection and try again."
                    : error.message
        );
    } finally {
        clearTimeout(timer);
        setBusy(false);
    }
}


// USER INTERACTIONS
function bindEvents() {
    $("identifyForm").addEventListener("submit", handleIdentify);
    $("chooseButton").addEventListener("click", () => $("photoInput").click());
    $("cameraButton").addEventListener("click", () => $("cameraInput").click());

    for (const id of ["photoInput", "cameraInput"]) {
        $(id).addEventListener("change", (event) => selectPhoto(event.target.files[0]));
    }

    $("removeButton").addEventListener("click", resetPhoto);

    const dropZone = $("dropZone");
    for (const name of ["dragenter", "dragover"]) {
        dropZone.addEventListener(name, (event) => {
            event.preventDefault();
            if (!busy) dropZone.classList.add("drag-over");
        });
    }
    for (const name of ["dragleave", "drop"]) {
        dropZone.addEventListener(name, (event) => {
            event.preventDefault();
            dropZone.classList.remove("drag-over");
        });
    }
    dropZone.addEventListener("drop", (event) => {
        if (busy) return;
        if (event.dataTransfer.files.length !== 1) {
            showError("Please choose one photo of one plant at a time.");
            return;
        }
        selectPhoto(event.dataTransfer.files[0]);
    });
}


// START APPLICATION
bindEvents();
