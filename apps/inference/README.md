# inference

Python FastAPI service for face detection + embedding, bib OCR, and quality flags. Called by the Node worker over HTTP.

## Endpoints

| Method | Path        | Status          | Lands in |
|--------|-------------|-----------------|----------|
| GET    | `/health`   | live            | F1.17    |
| POST   | `/detect/`  | live            | F1.18    |
| POST   | `/embed/`   | live            | F1.18    |
| POST   | `/ocr-bib/` | live            | F1.19    |
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

## Face model (`/detect/`, `/embed/`)

Face detection and ArcFace embeddings are powered by [InsightFace](https://github.com/deepinsight/insightface) running the `buffalo_l` model pack (SCRFD-10G detector + ArcFace R100, 512-d embeddings) on `onnxruntime` CPU.

The model is loaded lazily on the first request. The first call after a cold start triggers a ~300 MB download to `~/.insightface/models/buffalo_l/`. The Docker image pre-bakes this pack so containers boot hot. If the model is unavailable, `/detect/` and `/embed/` return `503 Service Unavailable`.

Limits:

- Max upload size: 16 MiB
- Max image dimension: 4096px (either axis); larger uploads return `413`
- Undecodable bytes return `422`

Example response shapes:

```jsonc
// POST /detect/
{
  "faces": [
    { "bbox": [x, y, w, h], "score": 0.987, "landmarks": [[x, y], ...] }
  ],
  "model_version": "insightface-buffalo_l-1.0"
}

// POST /embed/
{
  "vectors": [
    { "bbox": [x, y, w, h], "score": 0.987, "embedding": [/* 512 floats */] }
  ],
  "model_version": "insightface-buffalo_l-1.0",
  "embedding_dim": 512
}
```

## Bib OCR (`/ocr-bib/`)

Race-bib numbers are extracted with [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (English detector + recognizer, ~200 MB) running on CPU. Recognised text is post-filtered with a regex that keeps 2-5 digit values, optionally prefixed by a single uppercase letter (e.g. `A1234`), and rejects 4-digit years like `2024`.

The model is loaded lazily on the first request. Cold-start cost is ~5-10 seconds the first time the model is downloaded; the Docker image pre-bakes the cache so containers boot hot.

Limits match `/detect/` and `/embed/`: 16 MiB upload, 4096px max dimension (`413`), undecodable bytes return `422`.

Example response:

```jsonc
// POST /ocr-bib/
{
  "bibs": [
    {
      "bib_number": "1234",
      "confidence": 0.91,
      "bbox": [[x1, y1], [x2, y2], [x3, y3], [x4, y4]]
    }
  ],
  "model_version": "paddleocr-en-2.9"
}
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
