"""Image quality scoring route. Stubbed; real implementation lands in F3.12."""

import logging

from fastapi import APIRouter, Depends, UploadFile, status
from fastapi.responses import JSONResponse

from app.auth import require_api_key
from app.routes._common import NotImplementedResponse

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/quality",
    tags=["inference"],
    dependencies=[Depends(require_api_key)],
)


@router.post(
    "/",
    status_code=status.HTTP_501_NOT_IMPLEMENTED,
    response_model=NotImplementedResponse,
)
async def quality(image: UploadFile) -> JSONResponse:
    """Score quality signals for an uploaded image.

    Eventual response shape (F3.12):
        {"blur": 0.12, "eyes_closed": false, "duplicate_of": null}
    """
    logger.info("quality called with filename=%s (stub)", image.filename)
    body = NotImplementedResponse(
        error="not_implemented",
        message="Implemented in F3.12",
    )
    return JSONResponse(status_code=status.HTTP_501_NOT_IMPLEMENTED, content=body.model_dump())
