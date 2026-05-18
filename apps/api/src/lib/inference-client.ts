// F1.24 — inference HTTP client for the API layer.
//
// Mirrors apps/worker/src/lib/inference-client.ts. The API needs its own
// copy because selfie embedding happens synchronously in the request path,
// not via the worker queue. Keep both files in sync when the inference
// contract changes.

import { parseEnv, z } from '@pkg/env';
import { request } from 'undici';

const inferenceEnvSchema = z.object({
  INFERENCE_URL: z.string().url(),
  INFERENCE_API_KEY: z.string().min(1),
});

export type InferenceEnv = z.infer<typeof inferenceEnvSchema>;

let cachedEnv: InferenceEnv | undefined;
const getEnv = (): InferenceEnv => {
  if (!cachedEnv) cachedEnv = parseEnv(inferenceEnvSchema);
  return cachedEnv;
};

export interface DetectedFace {
  bbox: [number, number, number, number];
  score: number;
  embedding: number[];
}

export interface EmbedSelfieResult {
  vectors: DetectedFace[];
  modelVersion: string;
  embeddingDim: number;
}

export class InferenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InferenceUnavailableError';
  }
}

/**
 * POST a selfie buffer to the inference /embed/ endpoint and return the
 * detected faces with their embeddings. The buffer is streamed to the
 * inference service and is never written to disk or object storage by this
 * function. Throws InferenceUnavailableError on non-200 / network failure
 * so the caller can map to a 503.
 */
export const embedSelfie = async (
  imageBytes: Buffer,
  options: { filename?: string; contentType?: string } = {},
): Promise<EmbedSelfieResult> => {
  const env = getEnv();
  const filename = options.filename ?? 'selfie.jpg';
  const contentType = options.contentType ?? 'image/jpeg';

  const form = new FormData();
  form.append('image', new Blob([imageBytes], { type: contentType }), filename);

  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(`${env.INFERENCE_URL}/embed/`, {
      method: 'POST',
      body: form as unknown as Buffer,
      headers: { 'X-API-Key': env.INFERENCE_API_KEY },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InferenceUnavailableError(`inference unreachable: ${message}`);
  }

  if (res.statusCode !== 200) {
    const body = await res.body.text();
    throw new InferenceUnavailableError(`inference /embed/ ${res.statusCode}: ${body}`);
  }

  const raw = (await res.body.json()) as {
    vectors: DetectedFace[];
    model_version: string;
    embedding_dim: number;
  };

  return {
    vectors: raw.vectors,
    modelVersion: raw.model_version,
    embeddingDim: raw.embedding_dim,
  };
};
