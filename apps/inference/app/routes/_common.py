"""Shared response models for inference routes."""

from typing import Literal

from pydantic import BaseModel


class NotImplementedResponse(BaseModel):
    """501 response body for routes that are stubbed pending later milestones."""

    error: Literal["not_implemented"]
    message: str
