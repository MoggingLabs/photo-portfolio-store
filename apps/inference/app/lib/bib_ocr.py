"""Race-bib OCR helpers built on PaddleOCR.

The PaddleOCR model is large (~200 MB on first download) so we keep a single
lazy-initialised process-wide instance behind a threading lock. Recognised
text is filtered through a regex post-processor that keeps only plausible
race-bib numbers and rejects common false positives such as 4-digit years.

Accepted patterns (uppercase, whitespace stripped):
    "1"           -> rejected (too short)
    "12"          -> accepted
    "1234"        -> accepted
    "12345"       -> accepted
    "A1234"       -> accepted (single optional letter prefix)
    "AB123"       -> rejected (>1 letter prefix)
    "2024"        -> rejected (year-shaped 4-digit number)
    "ABC"         -> rejected (no digits)
    "123456"      -> rejected (too long)
"""

from __future__ import annotations

import logging
import re
from threading import Lock
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import numpy as np
    from paddleocr import PaddleOCR

logger = logging.getLogger(__name__)

_MODEL_VERSION = "paddleocr-en-2.9"

# Bib numbers are 2-5 digit integers, optionally preceded by a single uppercase
# letter (e.g. "A1234"). Pure-year 4-digit values (1900-2099) are filtered out
# separately because they overlap with the digit range used by race bibs.
BIB_REGEX = re.compile(r"^([A-Z]?\d{2,5})$")
YEAR_REGEX = re.compile(r"^(19|20)\d{2}$")

_ocr: PaddleOCR | None = None
_lock = Lock()


def get_ocr() -> PaddleOCR:
    """Return the process-wide :class:`PaddleOCR` instance, loading it on first use."""
    global _ocr
    with _lock:
        if _ocr is None:
            logger.info("loading PaddleOCR model (%s)", _MODEL_VERSION)
            from paddleocr import PaddleOCR

            _ocr = PaddleOCR(use_angle_cls=False, lang="en", show_log=False)
        return _ocr


def _is_bib_candidate(text: str) -> bool:
    """Return True when ``text`` matches the bib-number shape and is not a year."""
    if not BIB_REGEX.match(text):
        return False
    if YEAR_REGEX.match(text):
        return False
    return True


def extract_bib_candidates(image_bgr: np.ndarray) -> list[dict[str, Any]]:
    """Run OCR on ``image_bgr`` and return plausible race-bib detections.

    Args:
        image_bgr: Decoded image as a ``uint8`` ndarray of shape ``(H, W, 3)``
            in BGR channel order (matching :func:`app.lib.image.decode_image`).

    Returns:
        A list of detection dicts with ``bib_number`` (str), ``confidence``
        (float in [0, 1]), and ``bbox`` (list of four ``[x, y]`` corners).
    """
    ocr = get_ocr()
    result = ocr.ocr(image_bgr, cls=False)
    if not result or not result[0]:
        return []

    candidates: list[dict[str, Any]] = []
    for line in result[0]:
        bbox, (text, confidence) = line
        cleaned = text.strip().upper().replace(" ", "")
        if not _is_bib_candidate(cleaned):
            continue
        candidates.append(
            {
                "bib_number": cleaned,
                "confidence": float(confidence),
                "bbox": [[float(x), float(y)] for x, y in bbox],
            }
        )
    return candidates


def model_version() -> str:
    """Return the human-readable identifier for the currently loaded OCR model."""
    return _MODEL_VERSION
