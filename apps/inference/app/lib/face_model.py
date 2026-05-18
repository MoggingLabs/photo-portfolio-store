"""Lazy-loaded InsightFace model singleton.

The model is loaded on first use so the FastAPI app can boot quickly even
when the InsightFace model bundle hasn't been downloaded yet. Routes should
catch RuntimeError and translate to HTTP 503.
"""

from __future__ import annotations

import logging
from threading import Lock
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from insightface.app import FaceAnalysis

logger = logging.getLogger(__name__)

# 'buffalo_l' is the standard InsightFace pack:
# - SCRFD-10G face detector
# - ArcFace R100 (512-d embeddings)
MODEL_NAME = "buffalo_l"
EMBEDDING_DIM = 512

_model: FaceAnalysis | None = None
_lock = Lock()


def get_model() -> FaceAnalysis:
    """Return the lazily-initialised InsightFace ``FaceAnalysis`` instance.

    Thread-safe; the first caller pays the load cost while later callers wait
    on the lock and then receive the cached singleton.

    Raises:
        RuntimeError: if the InsightFace model bundle is not available and
            cannot be prepared. Callers should translate this to HTTP 503.
    """
    global _model
    with _lock:
        if _model is None:
            try:
                from insightface.app import FaceAnalysis
            except ImportError as exc:  # pragma: no cover - import guard
                raise RuntimeError("insightface is not installed") from exc

            logger.info("loading InsightFace model pack name=%s", MODEL_NAME)
            try:
                analyser = FaceAnalysis(
                    name=MODEL_NAME,
                    providers=["CPUExecutionProvider"],
                )
                analyser.prepare(ctx_id=0, det_size=(640, 640))
            except Exception as exc:
                logger.exception("failed to load InsightFace model pack")
                raise RuntimeError(
                    f"InsightFace model pack '{MODEL_NAME}' is not available"
                ) from exc
            _model = analyser
            logger.info("InsightFace model ready name=%s", MODEL_NAME)
        return _model


def model_version() -> str:
    """Return a stable identifier for the loaded model pack."""
    return f"insightface-{MODEL_NAME}-1.0"
