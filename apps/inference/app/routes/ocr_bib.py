"""Race-bib OCR route backed by PaddleOCR (F1.19)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from app.auth import require_api_key
from app.lib.bib_ocr import extract_bib_candidates, model_version
from app.lib.image import ImageDecodeError, ImageTooLarge, decode_image

logger = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 16 * 1024 * 1024  # 16 MiB

router = APIRouter(
    prefix="/ocr-bib",
    tags=["inference"],
    dependencies=[Depends(require_api_key)],
)


class BibDetection(BaseModel):
    """A single OCR-recognised race bib in an uploaded image."""

    bib_number: str = Field(..., description="Cleaned bib text, e.g. '1234' or 'A1234'.")
    confidence: float = Field(..., ge=0.0, le=1.0, description="OCR confidence score.")
    bbox: list[list[float]] = Field(
        ...,
        description="Four [x, y] corner points of the detection polygon.",
    )


class OcrBibResponse(BaseModel):
    """Response body for ``POST /ocr-bib/``."""

    bibs: list[BibDetection]
    model_version: str


@router.post("/", response_model=OcrBibResponse)
async def ocr_bib(image: UploadFile) -> OcrBibResponse:
    """OCR race-bib numbers in an uploaded image."""
    raw = await image.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        logger.warning(
            "ocr_bib rejected oversize upload filename=%s size=%d",
            image.filename,
            len(raw),
        )
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"image exceeds {MAX_UPLOAD_BYTES} byte limit",
        )

    try:
        image_bgr = decode_image(raw)
    except ImageTooLarge as exc:
        logger.warning("ocr_bib rejected oversize image filename=%s: %s", image.filename, exc)
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(exc),
        ) from exc
    except ImageDecodeError as exc:
        logger.warning("ocr_bib rejected undecodable image filename=%s: %s", image.filename, exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="unable to decode image",
        ) from exc

    candidates = extract_bib_candidates(image_bgr)
    logger.info(
        "ocr_bib filename=%s detected=%d", image.filename, len(candidates)
    )
    return OcrBibResponse(
        bibs=[BibDetection(**c) for c in candidates],
        model_version=model_version(),
    )
