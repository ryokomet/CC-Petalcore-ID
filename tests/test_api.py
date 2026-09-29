import io
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from api import index


def photo():
    output = io.BytesIO()
    Image.new("RGB", (32, 32), (30, 100, 40)).save(output, "PNG")
    return output.getvalue()


PAYLOAD = {"results": [{"score": 0.91, "species": {
    "scientificNameWithoutAuthor": "Rosa chinensis", "commonNames": ["China rose"],
    "family": {"scientificNameWithoutAuthor": "Rosaceae"},
    "genus": {"scientificNameWithoutAuthor": "Rosa"}
}}]}


class IdentificationTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(index.app)
        self.headers = {"x-api-key": index.API_KEY}

    def post(self, content=None, mime="image/png", organ="auto", headers=None):
        return self.client.post("/api/v1/identify", headers=self.headers if headers is None else headers,
                                files={"image": ("photo.png", photo() if content is None else content, mime)},
                                data={"organ": organ})

    def test_health_and_only_public_assets(self):
        self.assertEqual(self.client.get("/health").status_code, 200)
        for path in ["/", "/app.js", "/style.css", "/docs"]:
            self.assertEqual(self.client.get(path).status_code, 200)
        for path in ["/.env", "/api/index.py", "/requirements.txt"]:
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_config_does_not_expose_provider_key(self):
        with patch.object(index, "PLANTNET_API_KEY", "private-provider-secret"):
            self.assertNotIn("private-provider-secret", self.client.get("/config").text)

    def test_missing_and_wrong_keys(self):
        for headers in [{}, {"x-api-key": "wrong"}]:
            self.assertEqual(self.post(headers=headers).status_code, 401)

    def test_valid_result_and_safe_reencoding(self):
        with patch.object(index, "request_identification", new_callable=AsyncMock, return_value=PAYLOAD) as upstream:
            response = self.post(organ="flower")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["results"][0]["scientific_name"], "Rosa chinensis")
            self.assertEqual(response.json()["count"], 1)
            content, organ = upstream.call_args.args
            self.assertEqual(organ, "flower")
            self.assertEqual(Image.open(io.BytesIO(content)).format, "JPEG")

    def test_invalid_uploads_never_call_provider(self):
        with patch.object(index, "request_identification", new_callable=AsyncMock) as upstream:
            for content, mime, status in [(b"", "image/png", 422), (b"not a photo", "image/png", 422),
                                          (b"text", "text/plain", 415),
                                          (b"x" * (index.MAX_IMAGE_BYTES + 1), "image/jpeg", 413)]:
                self.assertEqual(self.post(content, mime).status_code, status)
            self.assertEqual(self.post(organ="root").status_code, 422)
            upstream.assert_not_called()

    def test_large_request_rejected(self):
        response = self.client.post("/api/v1/identify", content=b"x" * (index.MAX_REQUEST_BYTES + 1), headers=self.headers)
        self.assertEqual(response.status_code, 413)

    def test_missing_configuration(self):
        with patch.object(index, "PLANTNET_API_KEY", ""):
            self.assertEqual(self.post().status_code, 503)

    def test_provider_statuses_and_no_match(self):
        with patch.object(index, "PLANTNET_API_KEY", "test-secret"):
            for upstream_status, expected in [(401, 503), (403, 503), (429, 429), (500, 502), (400, 422), (404, 200)]:
                with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock,
                                  return_value=httpx.Response(upstream_status, json={"error": "private details"})):
                    response = self.post()
                    self.assertEqual(response.status_code, expected)
                    self.assertNotIn("private details", response.text)
                    if upstream_status == 404:
                        self.assertEqual(response.json()["results"], [])

    def test_timeouts_and_network_errors(self):
        with patch.object(index, "PLANTNET_API_KEY", "test-secret"):
            for error, expected in [(httpx.ReadTimeout("private details"), 504), (httpx.ConnectError("private details"), 502)]:
                with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock, side_effect=error):
                    response = self.post()
                    self.assertEqual(response.status_code, expected)
                    self.assertNotIn("private details", response.text)

    def test_malformed_provider_response(self):
        for payload in [{}, {"results": None}, {"results": [{"score": "bad", "species": {}}]}]:
            with patch.object(index, "request_identification", new_callable=AsyncMock, return_value=payload):
                self.assertEqual(self.post().status_code, 502)

    def test_upstream_request_contract(self):
        with patch.object(index, "PLANTNET_API_KEY", "test-secret"):
            with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock,
                              return_value=httpx.Response(200, json=PAYLOAD)) as request:
                self.assertEqual(self.post(organ="leaf").status_code, 200)
                self.assertEqual(request.call_args.kwargs["params"]["api-key"], "test-secret")
                self.assertEqual(request.call_args.kwargs["data"], {"organs": "leaf"})
                self.assertIn("images", request.call_args.kwargs["files"])


if __name__ == "__main__":
    unittest.main()
