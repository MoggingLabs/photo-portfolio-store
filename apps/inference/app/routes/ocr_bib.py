"""Bib number OCR route. Stubbed; real implementation lands in F1.19."""

import logging

from fastapi import APIRouter, Depends, UploadFile, status
from fastapi.responses import JSONResponse

from app.auth import require_api_key
from app.routes._common import NotImplementedResponse

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/ocr-bib",
    tags=["inference"],
    dependencies=[Depends(require_api_key)],
)


@router.post(
    "/",
    status_code=status.HTTP_501_NOT_IMPLEMENTED,
    response_model=NotImplementedResponse,
)
async def ocr_bib(image: UploadFile) -> JSONResponse:
    """OCR race-bib numbers in an uploaded image.

    Eventual response shape (F1.19):
        {"bibs": [{"number": "1234", "confidence": 0.91, "bbox": [x, y, w, h]}, ...]}
    """
    logger.info("ocr_bib called with filename=%s (stub)", image.filename)
    body = NotImplementedResponse(
        error="not_implemented",
        message="Implemented in F1.19",
    )
    return JSONResponse(status_code=status.HTTP_501_NOT_IMPLEMENTED, content=body.model_dump())
