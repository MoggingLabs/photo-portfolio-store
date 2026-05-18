# inference

Python FastAPI service for face detection + embedding, bib OCR, and quality flags. Called by the Node worker over HTTP.

## Endpoints

| Method | Path        | Status          | Lands in |
|--------|-------------|-----------------|----------|
| GET    | `/health`   | live            | F1.17    |
| POST   | `/detect/`  | 501 (stub)      | F1.18    |
| POST   | `/embed/`   | 501 (stub)      | F1.18    |
| POST   | `/ocr-bib/` | 501 (stub)      | F1.19    |
| POST   | `/quality/` | 501 (stub)      | F3.12    |

All POST routes accept multipart upload with a single `image` file field.

## Authentication

Every non-health route requires the `X-API-Key` header. The expected value is loaded from the `INFERENCE_API_KEY` env var (default `dev-shared-secret`).

- Missing header -> `401 Unauthorized`
- Wrong value   -> `403 Forbidden`
- `/health` is exempt.

```
curl -X POST http://localhost:8000/detect/ \
  -H "X-API-Key: dev-shared-secret" \
  -F "image=@photo.jpg"
```

## Local development

```bash
# from repo root
pnpm py:dev     # runs uvicorn with reload on :8000
pnpm py:test    # runs pytest
pnpm py:lint    # runs ruff check
pnpm py:format  # runs ruff format

# or directly inside apps/inference
uv venv
uv pip install -e ".[dev]"
uv run uvicorn app.main:app --reload
```

## Health check

```
GET /health -> { "status": "ok", "service": "inference", "version": "0.1.0" }
```

## Container

```bash
# from apps/inference
docker build -t inference:dev .
docker run --rm -p 8000:8000 \
  -e INFERENCE_API_KEY=dev-shared-secret \
  inference:dev
```

The image is multi-stage (`python:3.12-slim` builder + runtime), runs as a non-root user, exposes port 8000, and ships a `HEALTHCHECK` that curls `/health`.
