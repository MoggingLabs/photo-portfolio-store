# syntax=docker/dockerfile:1.7

# --- Stage 1: builder -------------------------------------------------------
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml ./
COPY app ./app

RUN uv pip install --system --no-cache .

# Pre-download the InsightFace 'buffalo_l' model pack (~300 MB) into the
# builder so the runtime image starts hot. Tradeoff: larger image vs no
# cold-start download penalty on first /detect/ or /embed/ request.
RUN python -c "from insightface.app import FaceAnalysis; m=FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider']); m.prepare(ctx_id=0, det_size=(640,640))"

# F1.19: pre-download PaddleOCR English detector + recognizer (~200 MB) so
# /ocr-bib/ does not pay a cold-start download on the first request.
RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=False, lang='en', show_log=False)"

# --- Stage 2: runtime -------------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 inference \
    && useradd  --system --uid 1001 --gid inference --home /app inference

WORKDIR /app

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /app /app
# Pre-baked InsightFace model pack (see builder stage).
COPY --from=builder /root/.insightface /home/inference/.insightface
# Pre-baked PaddleOCR model cache (see builder stage, F1.19).
COPY --from=builder /root/.paddleocr /home/inference/.paddleocr

RUN chown -R inference:inference /app /home/inference/.insightface /home/inference/.paddleocr
USER inference

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
