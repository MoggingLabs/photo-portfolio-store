// F1.24 — selfie-based face search route.
//
// POST /v1/events/:eventId/search/face       multipart/form-data
//   - selfie: image/jpeg|png|heic, <= 8 MiB
//   - consent_id: uuid from a prior consent grant
//
// Anonymous-allowed. The endpoint is gated by F1.33 biometric consent, not
// RBAC. Selfie bytes are streamed into memory, embedded, discarded. They are
// NEVER written to disk or object storage.

import multipart from '@fastify/multipart';
import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { hashIp } from '../lib/ip-hash.js';
import {
  FaceSearchError,
  type FaceSearchErrorCode,
  runFaceSearch,
} from '../services/face-search.js';

const SELFIE_PART = 'selfie';
const CONSENT_PART = 'consent_id';
const MAX_BYTES = 8 * 1024 * 1024;

const eventParamSchema = z.object({ eventId: z.string().uuid() });
const consentIdSchema = z.string().uuid();

const getClientIp = (req: FastifyRequest): string => {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]?.trim() ?? req.ip;
  return req.ip;
};

const getUserAgent = (req: FastifyRequest): string | undefined => {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : undefined;
};

const codeToStatus = (code: FaceSearchErrorCode): number => {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'consent_required':
      return 401;
    case 'consent_invalid':
      return 403;
    case 'not_found':
      return 404;
    case 'selfie_too_large':
      return 413;
    case 'unsupported_media_type':
      return 415;
    case 'no_face_detected':
      return 422;
    case 'inference_unavailable':
      return 503;
    default:
      return 500;
  }
};

interface ParsedMultipart {
  selfie: Buffer;
  contentType: string;
  consentId: string;
}

const parseMultipart = async (request: FastifyRequest): Promise<ParsedMultipart> => {
  let selfieBuf: Buffer | null = null;
  let contentType = 'application/octet-stream';
  let consentIdRaw: string | null = null;

  // @fastify/multipart provides request.parts(). We iterate, but require
  // selfie to stay in memory (we never want fs writes).
  interface MultipartFilePart {
    type: 'file';
    fieldname: string;
    mimetype: string;
    toBuffer: () => Promise<Buffer>;
    file: { truncated: boolean };
  }
  interface MultipartFieldPart {
    type: 'field';
    fieldname: string;
    value: unknown;
  }
  type MultipartPart = MultipartFilePart | MultipartFieldPart;

  const parts = (
    request as unknown as { parts: (o: object) => AsyncIterable<MultipartPart> }
  ).parts({ limits: { fileSize: MAX_BYTES, files: 1 } });
  for await (const part of parts) {
    if (part.type === 'file') {
      if (part.fieldname !== SELFIE_PART) {
        // Drain and ignore unknown file parts.
        await part.toBuffer();
        continue;
      }
      const buf = await part.toBuffer();
      if (part.file.truncated) {
        throw new FaceSearchError('selfie_too_large', 'selfie exceeds 8 MiB');
      }
      selfieBuf = buf;
      contentType = part.mimetype || contentType;
    } else if (part.fieldname === CONSENT_PART) {
      consentIdRaw = typeof part.value === 'string' ? part.value : null;
    }
  }

  if (!consentIdRaw) {
    throw new FaceSearchError('consent_required', 'consent_id missing');
  }
  const parsedConsent = consentIdSchema.safeParse(consentIdRaw);
  if (!parsedConsent.success) {
    throw new FaceSearchError('invalid_request', 'consent_id is not a uuid');
  }
  if (!selfieBuf || selfieBuf.length === 0) {
    throw new FaceSearchError('invalid_request', 'selfie missing');
  }

  return { selfie: selfieBuf, contentType, consentId: parsedConsent.data };
};

export interface SearchFaceRoutesOptions {
  db?: DbClient;
}

const searchFaceRoutes = async (
  app: FastifyInstance,
  opts: SearchFaceRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // Register multipart only inside this plugin's encapsulation context so it
  // does not leak to other routes. attachFieldsToBody:false keeps streaming
  // semantics — we iterate parts manually.
  await app.register(multipart, {
    limits: {
      fileSize: MAX_BYTES,
      files: 1,
      fields: 8,
    },
  });

  app.post(
    '/v1/events/:eventId/search/face',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = eventParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });

      let parsed: ParsedMultipart;
      try {
        parsed = await parseMultipart(request);
      } catch (err) {
        if (err instanceof FaceSearchError) {
          return reply.code(codeToStatus(err.code)).send({ error: err.code, message: err.message });
        }
        // Multipart parse errors (e.g. fastify/multipart's RequestFileTooLargeError)
        const message = err instanceof Error ? err.message : String(err);
        if (/file too large/i.test(message) || /maxFileSize/i.test(message)) {
          return reply.code(413).send({ error: 'selfie_too_large' });
        }
        request.log.error({ err }, 'multipart parse failed');
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const ipHash = hashIp(getClientIp(request));
      const userAgent = getUserAgent(request);

      try {
        const result = await runFaceSearch(db, {
          eventId: params.data.eventId,
          consentId: parsed.consentId,
          selfieBytes: parsed.selfie,
          selfieContentType: parsed.contentType,
          ipHash,
          userAgent,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof FaceSearchError) {
          return reply.code(codeToStatus(err.code)).send({ error: err.code, message: err.message });
        }
        request.log.error({ err }, 'face search failed');
        return reply.code(500).send({ error: 'server_error' });
      } finally {
        // Best-effort GC hint — overwrite the buffer reference so the bytes
        // are eligible for GC promptly. We do NOT zero the memory (not
        // possible reliably from JS); we just drop references.
        parsed.selfie = Buffer.alloc(0);
      }
    },
  );
};

export default searchFaceRoutes;
