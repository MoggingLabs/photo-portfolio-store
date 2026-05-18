"""Face embedding route. Stubbed; real implementation lands in F1.18."""

import logging

from fastapi import APIRouter, Depends, UploadFile, status
from fastapi.responses import JSONResponse

from app.auth import require_api_key
from app.routes._common import NotImplementedResponse

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/embed",
    tags=["inference"],
    dependencies=[Depends(require_api_key)],
)


@router.post(
    "/",
    status_code=status.HTTP_501_NOT_IMPLEMENTED,
    response_model=NotImplementedResponse,
)
async def embed(image: UploadFile) -> JSONResponse:
    """Compute face embeddings for an uploaded image.

    Eventual response shape (F1.18):
        {"vectors": [{"bbox": [x, y, w, h], "embedding": [<512 floats>]}, ...]}
    """
    logger.info("embed called with filename=%s (stub)", image.filename)
    body = NotImplementedResponse(
        error="not_implemented",
        message="Implemented in F1.18",
    )
    return JSONResponse(status_code=status.HTTP_501_NOT_IMPLEMENTED, content=body.model_dump())
