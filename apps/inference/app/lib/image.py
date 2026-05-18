"""Image decoding helpers shared across inference routes."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, UnidentifiedImageError

MAX_DIMENSION = 4096
"""Largest accepted dimension (width or height) in pixels.

Anything larger is rejected to bound memory use during decode / inference.
"""


class ImageTooLarge(ValueError):
    """Raised when a decoded image exceeds :data:`MAX_DIMENSION` in either axis."""


class ImageDecodeError(ValueError):
    """Raised when the supplied bytes cannot be decoded as an image."""


def decode_image(raw: bytes) -> np.ndarray:
    """Decode raw bytes into a contiguous BGR ``ndarray`` of shape ``(H, W, 3)``.

    InsightFace and OpenCV expect BGR-ordered pixel data, so we convert from
    Pillow's RGB output before returning.

    Args:
        raw: Raw image bytes (JPEG, PNG, WebP, ...).

    Returns:
        Decoded image as a ``uint8`` ndarray with shape ``(H, W, 3)`` in BGR order.

    Raises:
        ImageDecodeError: if the bytes do not represent a supported image.
        ImageTooLarge: if either dimension exceeds :data:`MAX_DIMENSION`.
    """
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ImageDecodeError("unable to decode image") from exc

    if max(img.size) > MAX_DIMENSION:
        raise ImageTooLarge(
            f"image dimension {max(img.size)}px exceeds limit {MAX_DIMENSION}px"
        )

    rgb = np.array(img.convert("RGB"))
    # Pillow returns RGB; InsightFace/OpenCV use BGR. Copy to ensure contiguity.
    return rgb[:, :, ::-1].copy()
