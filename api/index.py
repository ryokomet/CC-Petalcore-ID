import hmac
import os
import warnings
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

# CONFIGURATION
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent / ".env")
APP_TITLE = "Petalcore ID API"
API_VERSION = "1.0"
API_PREFIX = "/api/v1"
# This browser client key identifies ID, not an individual user. It is public.
API_KEY = os.getenv("PETALCORE_ID_API_KEY", "petalcore-id-public-client")
PLANTNET_API_KEY = os.getenv("PLANTNET_API_KEY", "")
PLANTNET_URL = "https://my-api.plantnet.org/v2/identify/all"
MAX_IMAGE_BYTES = 4_000_000
MAX_REQUEST_BYTES = 4_200_000
MAX_PIXELS = 25_000_000
Organ = Literal["auto", "leaf", "flower", "fruit", "bark"]

app = FastAPI(title=APP_TITLE, description="Identify a plant from a photograph with Pl@ntNet.", version=API_VERSION)
api_router = APIRouter(prefix=API_PREFIX, tags=["Identification"])
allowed_origins = [value.strip() for value in os.getenv("ALLOWED_ORIGINS", "").split(",") if value.strip()]
if allowed_origins:
    app.add_middleware(CORSMiddleware, allow_origins=allowed_origins,
                       allow_methods=["GET", "POST"], allow_headers=["x-api-key", "Content-Type"])


# Bound the body before multipart parsing, including requests without Content-Length.
class UploadLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        messages, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            size += len(message.get("body", b""))
            if size > MAX_REQUEST_BYTES:
                return await JSONResponse({"detail": "Photo is too large. Upload an image under 4 MB."}, status_code=413)(scope, receive, send)
            messages.append(message)
            if not message.get("more_body", False):
                break
        iterator = iter(messages)

        async def replay():
            return next(iterator, {"type": "http.request", "body": b"", "more_body": False})

        await self.app(scope, replay, send)


app.add_middleware(UploadLimitMiddleware)


# DATA MODELS
class PlantMatch(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    scientific_name: str = Field(min_length=1)
    common_names: list[str]
    family: str
    genus: str
    score: float = Field(ge=0, le=1, allow_inf_nan=False)


class IdentificationResponse(BaseModel):
    results: list[PlantMatch]
    count: int = Field(ge=0)
    organ: Organ
    provider: str = "Pl@ntNet"


# API KEY AUTHENTICATION
def verify_api_key(x_api_key: str | None = Header(default=None)):
    if not API_KEY or not x_api_key or not hmac.compare_digest(x_api_key.encode(), API_KEY.encode()):
        raise HTTPException(status_code=401, detail="Invalid or missing API key.")


# IMAGE VALIDATION
def prepare_image(content: bytes) -> bytes:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as source:
                if source.format not in {"JPEG", "PNG"}:
                    raise HTTPException(415, "Please upload a JPG or PNG photo.")
                if source.width * source.height > MAX_PIXELS:
                    raise HTTPException(413, "Photo dimensions are too large. Please resize it first.")
                source.verify()
            with Image.open(BytesIO(content)) as source:
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((2048, 2048))
                output = BytesIO()
                # Re-encoding removes EXIF/GPS metadata before sending to Pl@ntNet.
                image.save(output, format="JPEG", quality=90)
                return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(422, "This photo could not be read. Please choose another JPG or PNG.") from None


async def request_identification(content: bytes, organ: Organ) -> dict:
    if not PLANTNET_API_KEY:
        raise HTTPException(503, "Plant identification is not configured yet. Please contact the site owner.")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(35.0, connect=10.0)) as client:
            response = await client.post(
                PLANTNET_URL,
                params={"api-key": PLANTNET_API_KEY, "lang": "en", "nb-results": 5},
                data={"organs": organ},
                files={"images": ("plant.jpg", content, "image/jpeg")},
            )
    except httpx.TimeoutException:
        raise HTTPException(504, "Identification took too long. Please try again.") from None
    except httpx.RequestError:
        raise HTTPException(502, "The identification service could not be reached. Please try again.") from None
    if response.status_code == 404:
        return {"results": []}
    if response.status_code == 429:
        raise HTTPException(429, "The identification limit has been reached. Please try again later.")
    if response.status_code in {401, 403}:
        raise HTTPException(503, "The identification service key needs attention. Please contact the site owner.")
    if response.status_code in {400, 413, 415, 422}:
        raise HTTPException(422, "The identification service could not use this photo. Try a clearer JPG or PNG.")
    if not response.is_success:
        raise HTTPException(502, "The identification service is temporarily unavailable.")
    try:
        return response.json()
    except ValueError:
        raise HTTPException(502, "The identification service returned an unreadable response.") from None


# PUBLIC ROUTES
@app.get("/", include_in_schema=False)
def home():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/app.js", include_in_schema=False)
def javascript():
    return FileResponse(BASE_DIR / "app.js", media_type="text/javascript")


@app.get("/style.css", include_in_schema=False)
def stylesheet():
    return FileResponse(BASE_DIR / "style.css", media_type="text/css")


@app.get("/config", include_in_schema=False)
def public_config():
    # Never include the provider credential here. The ID client key is intentionally public.
    return JSONResponse({"api_url": os.getenv("PUBLIC_API_BASE_URL", API_PREFIX), "api_key": API_KEY},
                        headers={"Cache-Control": "no-store"})


@app.get("/health")
def health_check():
    return {"status": "ok", "service": APP_TITLE, "version": API_VERSION,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "identification_configured": bool(PLANTNET_API_KEY)}


# IDENTIFY A PLANT (Protected)
@api_router.post("/identify", response_model=IdentificationResponse, dependencies=[Depends(verify_api_key)])
async def identify_plant(image: UploadFile = File(...), organ: Organ = Form("auto")):
    try:
        if image.content_type not in {"image/jpeg", "image/png"}:
            raise HTTPException(415, "Please upload a JPG or PNG photo.")
        content = await image.read(MAX_IMAGE_BYTES + 1)
        if len(content) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Photo is too large. Upload an image under 4 MB.")
        if not content:
            raise HTTPException(422, "The uploaded photo is empty.")
        prepared = await run_in_threadpool(prepare_image, content)
        payload = await request_identification(prepared, organ)
        try:
            matches = []
            for item in payload["results"][:5]:
                species = item["species"]
                matches.append(PlantMatch(
                    scientific_name=species["scientificNameWithoutAuthor"],
                    common_names=species.get("commonNames", []),
                    family=species.get("family", {}).get("scientificNameWithoutAuthor", ""),
                    genus=species.get("genus", {}).get("scientificNameWithoutAuthor", ""),
                    score=item["score"],
                ))
            matches.sort(key=lambda item: item.score, reverse=True)
        except (KeyError, TypeError, AttributeError, ValidationError):
            raise HTTPException(502, "The identification service returned incomplete results. Please try again.") from None
        return IdentificationResponse(results=matches, count=len(matches), organ=organ)
    finally:
        await image.close()


app.include_router(api_router)
