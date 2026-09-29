# Petalcore ID

Take or upload a plant photo and see up to five possible identifications from Pl@ntNet. The interface keeps Petalcore Index's cream, forest green, Fraunces, and Work Sans design. The copied plant library has been replaced by the identification workflow; the existing `images/` folder is unused and unchanged.

## Structure

```text
api/
  index.py      FastAPI configuration, Pydantic models, authentication, provider call, and routes
  index.html    Photo upload and results page
  app.js        Camera/file selection, resizing, authenticated requests, and result rendering
  style.css     Responsive Petalcore layout
  images/       Existing reference assets, not used by identification
tests/test_api.py
.env.example
requirements.txt
vercel.json
```

## Run locally

From the repository root:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

If `.env` does not exist, copy `.env.example` to `.env`. Set `PLANTNET_API_KEY` to your private provider key. Existing environment variables take precedence over `.env`.

```powershell
.venv\Scripts\python -m uvicorn api.index:app --reload
```

Open `http://127.0.0.1:8000/`. The same server serves the frontend, `/health`, and interactive `/docs`. Use this server rather than opening the HTML file directly or through Live Server.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Public liveness check and provider configuration status |
| POST | `/api/v1/identify` | Identify a plant; requires `x-api-key` |
| GET | `/config` | Public browser configuration; never returns the Pl@ntNet key |

`POST /api/v1/identify` accepts multipart form data with one `image` (JPG or PNG) and `organ` (`auto`, `leaf`, `flower`, `fruit`, or `bark`). In `/docs`, choose **Try it out**, provide the `PETALCORE_ID_API_KEY` value in `x-api-key`, and upload an image.

The response contains `results`, `count`, `organ`, and `provider`. Each result includes `scientific_name`, `common_names`, `family`, `genus`, and `score` (0 to 1). Scores express possible matches, not confirmed identification. No invented plant descriptions or stock result photos are shown.

### Two separate keys

- `PLANTNET_API_KEY` is a private provider credential. It stays in the server environment, is sent only to Pl@ntNet, and must never be placed in JavaScript or committed.
- `PETALCORE_ID_API_KEY` identifies the ID browser client and differs from Index's key. The default is `petalcore-id-public-client`. `/config` supplies it to the browser, so it is **public**, not user authentication or protection against determined quota abuse. Add user authentication and a shared rate-limit store before unrestricted public use. Do not turn on HTTP-client debug logging that records provider URLs containing the provider key.

`.env` is ignored by Git. Uploaded images are processed temporarily and are not saved by this app. The server validates the decoded image and re-encodes it without EXIF/GPS metadata before sending it to Pl@ntNet. The UI explains that submission sends the photo to that provider.

## Limits and failures

The browser accepts JPG/PNG photos up to 20 MB and 25 megapixels, resizes them to fit 2048 × 2048, and sends at most 4 MB. The server caps the entire request at 4.2 MB, caps the image at 4 MB, validates the content, and allows only supported organ values. This leaves room beneath Vercel's 4.5 MB request limit. HEIC files must be converted to JPG first. On supported mobile browsers, **Take a photo** offers the rear camera; desktop browsers may show a file picker.

Missing/wrong client keys return 401. Invalid photos return 415/422, oversized uploads 413, provider quota exhaustion 429, timeouts 504, upstream failures 502, and missing/rejected provider credentials 503. A provider "species not found" response becomes an empty successful result, which the UI handles separately. The public health check reports server liveness; it does not spend an identification request to test the provider.

## Vercel

Import **CC-Petalcore-ID** with the repository root as Root Directory and FastAPI as the framework. `vercel.json` selects FastAPI; `pyproject.toml` explicitly sets the application entry point to `api.index:app`. Add `PLANTNET_API_KEY` under the project's Environment Variables for the intended deployment environments. Optionally set `PETALCORE_ID_API_KEY`. Redeploy after changing environment variables. The local `.env` is not uploaded by Git or Vercel CLI.

No deployment or Git push is performed by this implementation.

## Shared Petalcore API direction

This repository currently runs the ID feature on its own for development. It does **not** silently connect to or modify the existing Index backend. The protected identification routes are grouped in `api_router` with `/api/v1` so they can be registered in a central FastAPI application later. Set `PUBLIC_API_BASE_URL` to that API's full versioned URL once it actually exposes `/identify`, and configure its `ALLOWED_ORIGINS` and ID client key. The current Index backend must be extended before this switch. Index and Select repositories remain separate and unchanged.

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests -v
node --check api/app.js
```

The automated tests mock Pl@ntNet and do not consume identification quota. They cover authentication, upload validation, response normalization, public assets, secret exclusion, provider failures, and the upstream multipart contract.

## References

- [Pl@ntNet identification API](https://my.plantnet.org/doc/api/identify)
- [FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi)
- [Vercel request limits](https://vercel.com/docs/functions/limitations)
