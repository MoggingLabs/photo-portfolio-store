"""Route-level tests for inference stubs and API-key authentication."""

import io

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.settings import settings

client = TestClient(app)


def _image_payload() -> dict[str, tuple[str, io.BytesIO, str]]:
    return {"image": ("test.jpg", io.BytesIO(b"fake-bytes"), "image/jpeg")}


def _auth_headers() -> dict[str, str]:
    return {"X-API-Key": settings.inference_api_key}


@pytest.mark.parametrize(
    ("path", "expected_message"),
    [
        ("/quality/", "Implemented in F3.12"),
    ],
)
def test_stub_routes_return_501(path: str, expected_message: str) -> None:
    response = client.post(path, files=_image_payload(), headers=_auth_headers())
    assert response.status_code == 501
    body = response.json()
    assert body["error"] == "not_implemented"
    assert body["message"] == expected_message


def test_quality_returns_501() -> None:
    response = client.post("/quality/", files=_image_payload(), headers=_auth_headers())
    assert response.status_code == 501
    assert response.json()["error"] == "not_implemented"


def test_api_key_required() -> None:
    response = client.post("/detect/", files=_image_payload())
    assert response.status_code == 401


def test_api_key_wrong() -> None:
    response = client.post(
        "/detect/",
        files=_image_payload(),
        headers={"X-API-Key": "wrong-secret"},
    )
    assert response.status_code == 403


def test_health_no_auth() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
