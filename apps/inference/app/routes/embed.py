"""Face embedding route backed by InsightFace ArcFace (F1.18)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from app.auth import require_api_key
from app.lib.face_model import EMBEDDING_DIM, get_model, model_version
from app.lib.image import ImageDecodeError, ImageTooLarge, decode_image

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/embed",
    tags=["inference"],
    dependencies=[Depends(require_api_key)],
)

MAX_UPLOAD_BYTES = 16 * 1024 * 1024  # 16 MiB


class FaceEmbedding(BaseModel):
    """A single face with its 512-d ArcFace embedding."""

    bbox: list[float] = Field(
        ...,
        description="Bounding box in pixel coordinates as [x, y, width, height].",
        min_length=4,
        max_length=4,
    )
    score: float = Field(..., description="Detector confidence score in [0, 1].")
    embedding: list[float] = Field(..., description="ArcFace embedding vector.")


class EmbedResponse(BaseModel):
    """Response payload for ``POST /embed/``."""

    vectors: list[FaceEmbedding]
    model_version: str
    embedding_dim: int


def _bbox_xywh(raw: object) -> list[float]:
    x1, y1, x2, y2 = (float(v) for v in raw)  # type: ignore[misc]
    return [x1, y1, x2 - x1, y2 - y1]


@router.post("/", response_model=EmbedResponse)
async def embed(image: UploadFile) -> EmbedResponse:
    """Compute ArcFace embeddings for every face detected in the upload."""
    raw = await image.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        logger.warning("embed rejected oversized upload bytes=%d", len(raw))
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
        logger.error("embed failed: model unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="face model not ready",
        ) from exc

    raw_faces = model.get(bgr)
    vectors: list[FaceEmbedding] = []
    for face in raw_faces:
        embedding_arr = getattr(face, "embedding", None)
        if embedding_arr is None:
            logger.warning("embed skipping face without embedding")
            continue
        vectors.append(
            FaceEmbedding(
                bbox=_bbox_xywh(face.bbox),
                score=float(face.det_score),
                embedding=[float(v) for v in embedding_arr.tolist()],
            )
        )

    logger.info("embed filename=%s vectors=%d", image.filename, len(vectors))
    return EmbedResponse(
        vectors=vectors,
        model_version=model_version(),
        embedding_dim=EMBEDDING_DIM,
    )
