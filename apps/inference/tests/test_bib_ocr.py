"""Unit and route tests for the F1.19 race-bib OCR endpoint."""

from __future__ import annotations

import importlib.util
import io

import pytest
from fastapi.testclient import TestClient

from app.lib.bib_ocr import _is_bib_candidate
from app.main import app
from app.settings import settings

client = TestClient(app)


def _auth_headers() -> dict[str, str]:
    return {"X-API-Key": settings.inference_api_key}


def test_bib_regex_accepts_3_digit() -> None:
    assert _is_bib_candidate("123") is True


def test_bib_regex_rejects_year() -> None:
    assert _is_bib_candidate("2024") is False
    assert _is_bib_candidate("1999") is False


def test_bib_regex_rejects_pure_letters() -> None:
    assert _is_bib_candidate("ABC") is False


def test_bib_regex_rejects_too_long() -> None:
    assert _is_bib_candidate("123456") is False


def test_bib_regex_accepts_letter_prefix() -> None:
    assert _is_bib_candidate("A1234") is True


def test_bib_regex_rejects_single_digit() -> None:
    assert _is_bib_candidate("9") is False


def test_bib_regex_accepts_non_year_4_digit() -> None:
    # 4-digit values outside the year window should still pass.
    assert _is_bib_candidate("3456") is True
    assert _is_bib_candidate("1234") is True


_PADDLE_AVAILABLE = importlib.util.find_spec("paddleocr") is not None


@pytest.mark.skipif(
    not _PADDLE_AVAILABLE,
    reason="paddleocr not installed in this environment",
)
def test_ocr_endpoint_returns_empty_for_blank_image() -> None:
    """A blank white PNG should OCR cleanly to zero bib detections."""
    pil_image = pytest.importorskip("PIL.Image")
    buf = io.BytesIO()
    pil_image.new("RGB", (100, 100), color="white").save(buf, format="PNG")
    buf.seek(0)

    response = client.post(
        "/ocr-bib/",
        files={"image": ("blank.png", buf, "image/png")},
        headers=_auth_headers(),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["bibs"] == []
    assert body["model_version"] == "paddleocr-en-2.9"


def test_ocr_endpoint_requires_api_key() -> None:
    response = client.post(
        "/ocr-bib/",
        files={"image": ("x.jpg", io.BytesIO(b"fake"), "image/jpeg")},
    )
    assert response.status_code == 401


def test_ocr_endpoint_rejects_undecodable_image() -> None:
    response = client.post(
        "/ocr-bib/",
        files={"image": ("bad.jpg", io.BytesIO(b"not-an-image"), "image/jpeg")},
        headers=_auth_headers(),
    )
    assert response.status_code == 422
