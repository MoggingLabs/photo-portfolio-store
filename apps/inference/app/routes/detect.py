"""Face detection route. Stubbed; real implementation lands in F1.18."""

import logging

from fastapi import APIRouter, Depends, UploadFile, status
from fastapi.responses import JSONResponse

from app.auth import require_api_key
from app.routes._common import NotImplementedResponse

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/detect",
    tags=["inference"],
    dependencies=[Depends(require_api_key)],
)


@router.post(
    "/",
    status_code=status.HTTP_501_NOT_IMPLEMENTED,
    response_model=NotImplementedResponse,
)
async def detect(image: UploadFile) -> JSONResponse:
    """Detect faces in an uploaded image.

    Eventual response shape (F1.18):
        {"faces": [{"bbox": [x, y, w, h], "score": 0.99}, ...]}
    """
    logger.info("detect called with filename=%s (stub)", image.filename)
    body = NotImplementedResponse(
        error="not_implemented",
        message="Implemented in F1.18",
    )
    return JSONResponse(status_code=status.HTTP_501_NOT_IMPLEMENTED, content=body.model_dump())
