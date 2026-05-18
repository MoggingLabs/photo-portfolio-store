"""Health check route. Exempt from API key authentication."""

from fastapi import APIRouter

from app import __version__
from app.settings import settings

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    """Liveness probe. Returns service identity and version."""
    return {"status": "ok", "service": settings.service_name, "version": __version__}
