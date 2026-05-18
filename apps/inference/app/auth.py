"""Shared-secret API key authentication for the inference service.

Clients (the Node worker) must pass `X-API-Key: <secret>` on every non-health
request. The secret is configured via the `INFERENCE_API_KEY` env var and
loaded through `app.settings`.
"""

import logging

from fastapi import Header, HTTPException, status

from app.settings import settings

logger = logging.getLogger(__name__)


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """FastAPI dependency that enforces the shared-secret API key header.

    - 401 if the `X-API-Key` header is missing.
    - 403 if the header is present but does not match `settings.inference_api_key`.
    """
    if x_api_key is None:
        logger.warning("inference request rejected: missing X-API-Key header")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing X-API-Key header",
        )
    if x_api_key != settings.inference_api_key:
        logger.warning("inference request rejected: invalid X-API-Key header")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="invalid X-API-Key header",
        )
