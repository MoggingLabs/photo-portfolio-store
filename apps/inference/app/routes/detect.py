"""Face detection route backed by InsightFace SCRFD (F1.18)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from app.auth import require_api_key
from app.lib.face_model import get_model, model_version
from app.lib.image import ImageDecodeError, ImageTooLarge, decode_image

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/detect",
    tags=["inference"],
    dependencies=[Depends(require_api_key)],
)

MAX_UPLOAD_BYTES = 16 * 1024 * 1024  # 16 MiB


class FaceDetection(BaseModel):
    """A single detected face."""

    bbox: list[float] = Field(
        ...,
        description="Bounding box in pixel coordinates as [x, y, width, height].",
        min_length=4,
        max_length=4,
    )
    score: float = Field(..., description="Detector confidence score in [0, 1].")
    landmarks: list[list[float]] | None = Field(
        default=None,
        description="Optional 5-point facial landmarks (left eye, right eye, nose, left mouth, right mouth).",
    )


class DetectResponse(BaseModel):
    """Response payload for ``POST /detect/``."""

    faces: list[FaceDetection]
    model_version: str


def _bbox_xywh(raw: object) -> list[float]:
    # InsightFace returns bbox as [x1, y1, x2, y2] (numpy array).
    x1, y1, x2, y2 = (float(v) for v in raw)  # type: ignore[misc]
    return [x1, y1, x2 - x1, y2 - y1]


def _landmarks(raw: object) -> list[list[float]] | None:
    if raw is None:
        return None
    return [[float(v) for v in point] for point in raw]  # type: ignore[union-attr]


@router.post("/", response_model=DetectResponse)
async def detect(image: UploadFile) -> DetectResponse:
    """Detect faces in an uploaded image and return their bounding boxes."""
    raw = await image.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        logger.warning("detect rejected oversized upload bytes=%d", len(raw))
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"upload exceeds {MAX_UPLOAD_BYTES} bytes",
        )

    try:
        bgr = decode_image(raw)
    except ImageTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(exc),
        ) from exc
    except ImageDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    try:
        model = get_model()
    except RuntimeError as exc:
        logger.error("detect failed: model unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="face model not ready",
        ) from exc

    raw_faces = model.get(bgr)
    faces = [
        FaceDetection(
            bbox=_bbox_xywh(face.bbox),
            score=float(face.det_score),
            landmarks=_landmarks(getattr(face, "kps", None)),
        )
        for face in raw_faces
    ]
    logger.info("detect filename=%s faces=%d", image.filename, len(faces))
    return DetectResponse(faces=faces, model_version=model_version())
