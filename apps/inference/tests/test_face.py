"""Tests for the F1.18 face detection + embedding routes."""

from __future__ import annotations

import importlib.util
import io
import os
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.lib.face_model import EMBEDDING_DIM, MODEL_NAME, model_version
from app.main import app
from app.settings import settings

client = TestClient(app)


def _auth_headers() -> dict[str, str]:
    return {"X-API-Key": settings.inference_api_key}


def _png_bytes(width: int, height: int, color: tuple[int, int, int] = (255, 255, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=color).save(buf, format="PNG")
    return buf.getvalue()


def _model_pack_present() -> bool:
    """Detect whether the InsightFace model pack and runtime are available."""
    if importlib.util.find_spec("insightface") is None:
        return False
    pack_dir = Path(os.path.expanduser("~/.insightface/models")) / MODEL_NAME
    return pack_dir.is_dir()


_skip_no_model = pytest.mark.skipif(
    not _model_pack_present(),
    reason="InsightFace model pack not available locally",
)


def test_model_version_format() -> None:
    assert re.match(rf"^insightface-{re.escape(MODEL_NAME)}-\d", model_version())


def test_detect_rejects_huge_image() -> None:
    files = {"image": ("huge.png", io.BytesIO(_png_bytes(8000, 8000)), "image/png")}
    response = client.post("/detect/", files=files, headers=_auth_headers())
    assert response.status_code == 413


def test_embed_rejects_huge_image() -> None:
    files = {"image": ("huge.png", io.BytesIO(_png_bytes(8000, 8000)), "image/png")}
    response = client.post("/embed/", files=files, headers=_auth_headers())
    assert response.status_code == 413


def test_detect_rejects_corrupt_image() -> None:
    files = {"image": ("garbage.bin", io.BytesIO(b"\x00\x01not-an-image\xff"), "image/png")}
    response = client.post("/detect/", files=files, headers=_auth_headers())
    assert response.status_code == 422


def test_embed_rejects_corrupt_image() -> None:
    files = {"image": ("garbage.bin", io.BytesIO(b"\x00\x01not-an-image\xff"), "image/png")}
    response = client.post("/embed/", files=files, headers=_auth_headers())
    assert response.status_code == 422


@_skip_no_model
def test_detect_returns_face_list() -> None:
    files = {"image": ("blank.png", io.BytesIO(_png_bytes(640, 480)), "image/png")}
    response = client.post("/detect/", files=files, headers=_auth_headers())
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["faces"], list)
    assert body["model_version"].startswith(f"insightface-{MODEL_NAME}-")


@_skip_no_model
def test_embed_returns_correct_dim() -> None:
    # Real face photos would yield non-empty vectors; with a blank image the
    # detector may return zero faces. We assert the response shape regardless,
    # and check embedding length whenever a face is returned.
    files = {"image": ("blank.png", io.BytesIO(_png_bytes(640, 480)), "image/png")}
    response = client.post("/embed/", files=files, headers=_auth_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["embedding_dim"] == EMBEDDING_DIM
    for vector in body["vectors"]:
        assert len(vector["embedding"]) == EMBEDDING_DIM
