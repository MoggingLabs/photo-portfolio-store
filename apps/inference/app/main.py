"""FastAPI application entrypoint for the inference service."""

from fastapi import FastAPI

from app import __version__
from app.instrument import init_otel, init_sentry
from app.routes import detect, embed, health, ocr_bib, quality
from app.settings import settings

init_sentry()

app = FastAPI(title=settings.service_name, version=__version__)

init_otel(app)

app.include_router(health.router)
app.include_router(detect.router)
app.include_router(embed.router)
app.include_router(ocr_bib.router)
app.include_router(quality.router)
