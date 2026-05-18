// F1.24 — face-search route tests.
//
// Exercises the multipart parse + error mapping. Service-layer coverage is
// in face-search.service.test.ts. We mock the service to keep the route
// test focused on HTTP wiring.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://stub',
    JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-chars-long-xx',
    JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-chars-long-yy',
    INFERENCE_URL: 'http://localhost:8000',
    INFERENCE_API_KEY: 'key',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    S3_BUCKET_ORIGINALS: 'orig',
    S3_BUCKET_DERIVATIVES: 'deriv',
    S3_PUBLIC_BASE_URL: 'https://cdn.example.test',
  }),
  z: {
    object: () => ({
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    }),
    string: () => ({
      url: () => ({ optional: () => ({}) }),
      min: () => ({ default: () => ({}) }),
      default: () => ({}),
    }),
  },
}));

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    events: { tables: {} as Record<string, unknown> },
    photos: { tables: {} as Record<string, unknown> },
    search: { tables: {} as Record<string, unknown> },
    compliance: { tables: {} as Record<string, unknown> },
  },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = vi.fn();
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/x'),
}));

const runFaceSearchMock = vi.fn();

vi.mock('../src/services/face-search.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/face-search.js')>(
    '../src/services/face-search.js',
  );
  return {
    ...actual,
    runFaceSearch: (...args: unknown[]) => runFaceSearchMock(...args),
  };
});

const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const CONSENT_ID = '00000000-0000-4000-8000-0000000000c1';

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  const routes = (await import('../src/routes/search-face.js')).default;
  await app.register(routes, { db: {} as never });
  return app;
};

// Build a minimal multipart body manually.
const makeMultipart = (
  parts: Array<{
    name: string;
    value?: string;
    filename?: string;
    contentType?: string;
    data?: Buffer;
  }>,
  boundary = '----testboundary',
): { body: Buffer; headers: Record<string, string> } => {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename !== undefined && p.data) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`,
        ),
      );
      chunks.push(
        Buffer.from(`Content-Type: ${p.contentType ?? 'application/octet-stream'}\r\n\r\n`),
      );
      chunks.push(p.data);
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
      chunks.push(Buffer.from(p.value ?? ''));
      chunks.push(Buffer.from('\r\n'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  return {
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  };
};

const jpegHeader = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)]);

beforeEach(() => {
  runFaceSearchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /v1/events/:eventId/search/face', () => {
  it('200 on a valid multipart with selfie + consent_id', async () => {
    runFaceSearchMock.mockResolvedValueOnce({
      sessionId: 'sess-1',
      matches: [],
      warnings: [],
      consent: { searchesRemaining: 19, expiresAt: new Date().toISOString() },
    });
    const app = await buildApp();
    const { body, headers } = makeMultipart([
      { name: 'consent_id', value: CONSENT_ID },
      {
        name: 'selfie',
        filename: 'selfie.jpg',
        contentType: 'image/jpeg',
        data: jpegHeader,
      },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_ID}/search/face`,
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(runFaceSearchMock).toHaveBeenCalledOnce();
    await app.close();
  });

  it('401 consent_required when consent_id missing', async () => {
    const app = await buildApp();
    const { body, headers } = makeMultipart([
      {
        name: 'selfie',
        filename: 'selfie.jpg',
        contentType: 'image/jpeg',
        data: jpegHeader,
      },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_ID}/search/face`,
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'consent_required' });
    await app.close();
  });

  it('400 invalid_request when consent_id is not a uuid', async () => {
    const app = await buildApp();
    const { body, headers } = makeMultipart([
      { name: 'consent_id', value: 'not-a-uuid' },
      {
        name: 'selfie',
        filename: 'selfie.jpg',
        contentType: 'image/jpeg',
        data: jpegHeader,
      },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_ID}/search/face`,
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('maps service no_face_detected to 422', async () => {
    const { FaceSearchError } = await import('../src/services/face-search.js');
    runFaceSearchMock.mockRejectedValueOnce(new FaceSearchError('no_face_detected', 'nope'));
    const app = await buildApp();
    const { body, headers } = makeMultipart([
      { name: 'consent_id', value: CONSENT_ID },
      {
        name: 'selfie',
        filename: 'selfie.jpg',
        contentType: 'image/jpeg',
        data: jpegHeader,
      },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_ID}/search/face`,
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('maps service inference_unavailable to 503', async () => {
    const { FaceSearchError } = await import('../src/services/face-search.js');
    runFaceSearchMock.mockRejectedValueOnce(new FaceSearchError('inference_unavailable', 'down'));
    const app = await buildApp();
    const { body, headers } = makeMultipart([
      { name: 'consent_id', value: CONSENT_ID },
      {
        name: 'selfie',
        filename: 'selfie.jpg',
        contentType: 'image/jpeg',
        data: jpegHeader,
      },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_ID}/search/face`,
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('maps service consent_invalid to 403', async () => {
    const { FaceSearchError } = await import('../src/services/face-search.js');
    runFaceSearchMock.mockRejectedValueOnce(new FaceSearchError('consent_invalid', 'expired'));
    const app = await buildApp();
    const { body, headers } = makeMultipart([
      { name: 'consent_id', value: CONSENT_ID },
      {
        name: 'selfie',
        filename: 'selfie.jpg',
        contentType: 'image/jpeg',
        data: jpegHeader,
      },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_ID}/search/face`,
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('404 on malformed eventId', async () => {
    const app = await buildApp();
    const { body, headers } = makeMultipart([
      { name: 'consent_id', value: CONSENT_ID },
      {
        name: 'selfie',
        filename: 'selfie.jpg',
        contentType: 'image/jpeg',
        data: jpegHeader,
      },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events/not-a-uuid/search/face',
      headers,
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
