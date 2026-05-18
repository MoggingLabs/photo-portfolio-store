# Biometric processing compliance map (F1.33 + F1.24)

This document maps statutory requirements to the code path that satisfies
them. Each row points at a specific file/function and the audit-log action
that records the event for review.

The map covers LGPD (Brazil), GDPR (EU), BIPA (Illinois), and CCPA
(California). The system applies the strictest tier (GDPR) by default and
allows users to declare an alternative jurisdiction from a documented
enum at consent grant time.

## Files of record

- Consent service: `apps/api/src/services/consents.ts`
- Consent routes: `apps/api/src/routes/consents.ts`
- Face-search service: `apps/api/src/services/face-search.ts`
- Face-search route: `apps/api/src/routes/search-face.ts`
- Policy versions: `apps/api/src/lib/policy-versions.ts`
- Policy markdown bodies: `docs/compliance/policy-versions/2026-05-18/{en-US,pt-BR}.md`
- Soft-bind helper: `apps/api/src/lib/soft-bind.ts`
- IP hash helper: `apps/api/src/lib/ip-hash.ts`
- Consent schema: `packages/db/src/schema/compliance.ts`
- Migration: `packages/db/migrations/0003_consent_search_tracking.sql`

## LGPD (Lei 13.709/2018, Brazil)

| Requirement | Code path | Audit action |
|---|---|---|
| Art. 7(I) — consentimento como base legal | `grantConsent` requires all four explicit acknowledgements; `acknowledgements.biometricProcessing` must be `true` | `biometric.consent.granted` |
| Art. 11 — dado sensivel (biometrico) tratado com consentimento especifico e em destaque | `policy-versions.ts` enforces a versioned, locale-matched, in-scope policy body; unknown versions are rejected with 422 | `biometric.consent.granted` (payload.policyVersion) |
| Art. 18 — direitos do titular (acesso, eliminacao) | `DELETE /v1/consents/biometric/:id` (`revokeConsent`); cascade-deletes face_vectors when no other active consent references the event | `biometric.consent.revoked` (payload.vectorsPurged) |
| Art. 16 — eliminacao apos a finalidade | F1.35 retention cron purges by `retention_until`; `grantConsent` writes `retention_until = event.archivedAt|eventDate + retentionDays` | `biometric.consent.granted` |
| Art. 20 — revisao de decisoes automatizadas | Face search is informational, not a decision with legal/significant effects. Documented in policy body. | not applicable |
| Art. 46 — seguranca | IP never stored raw (only `sha256(salt || ip)`); email never stored raw (only `sha256(lower(email))`); selfie bytes never persisted | covered by `consent.suspicious_reuse` on bind mismatch |

## GDPR (Regulation 2016/679, EU)

| Requirement | Code path | Audit action |
|---|---|---|
| Art. 9(2)(a) — explicit consent for special-category data | Same as LGPD Art. 11 above; each acknowledgement is an individual `true` literal in zod | `biometric.consent.granted` |
| Art. 7(3) — right to withdraw consent at any time | `revokeConsent` synchronously purges face_vectors for the event if no other active consent depends on them; sets `revoked_at = now()` and `retention_until = now()` | `biometric.consent.revoked` |
| Art. 13 — information to the data subject | Policy body in `policy-versions.ts` (mirrored in `docs/compliance/policy-versions/`) covers purpose, recipients, retention, rights | `biometric.consent.granted` (payload includes the policy version the subject saw) |
| Art. 15 — right of access | Out-of-band privacy@example.com; documented in policy body | not applicable |
| Art. 17 — right to erasure | `revokeConsent` deletes face_vectors within the same HTTP request | `biometric.consent.revoked` |
| Art. 22 — automated decision-making | Search returns matches for display; no decision with legal/significant effects is produced. Documented in policy body. | not applicable |
| Art. 25 — data protection by design | IP hashed with project secret salt; email hashed with one-way SHA-256; selfie bytes streamed and discarded; per-event Qdrant collection so a single takedown wipes biometric data for one event | covered across all `biometric.*` actions |
| Art. 32 — security of processing | Soft-bind (`softBindMatch`) detects stolen-consent_id reuse; per-IP rate limit on consent grants; per-consent 20-search quota; 24h TTL | `consent.suspicious_reuse`, `biometric.search.face.denied` |

## BIPA (740 ILCS 14, Illinois)

| Requirement | Code path | Audit action |
|---|---|---|
| Sec. 14/15(b) — written consent before collection | `grantConsent` requires explicit boolean acknowledgements for biometric processing; policy body in `policy-versions.ts` is treated as the written notice | `biometric.consent.granted` |
| Sec. 14/15(a) — written, publicly available retention schedule | `policy-versions.ts` body cites `event.retention_days`; F1.35 cron enforces | `biometric.consent.granted` |
| Sec. 14/15(c) — no sale/profit | Documented in policy body; no code path connects face_vectors to any monetisation surface | not applicable |
| Sec. 14/15(d) — destruction at earlier of "purpose satisfied" or 3 years | `retention_days` defaults to 30 (well under the BIPA ceiling); `revokeConsent` allows the subject to force earlier deletion | `biometric.consent.revoked` |

## CCPA / CPRA (California)

| Requirement | Code path | Audit action |
|---|---|---|
| Cal. Civ. Code 1798.100 — right to know | Policy body + GET /v1/consents/biometric/:id | not applicable |
| Cal. Civ. Code 1798.105 — right to delete | `revokeConsent` | `biometric.consent.revoked` |
| Cal. Civ. Code 1798.120 — right to opt-out of sale | No biometric data is sold; documented in policy body | not applicable |

## Audit-log action catalogue

| Action | Emitted by | Trigger |
|---|---|---|
| `biometric.consent.granted` | `grantConsent` | Successful POST /v1/consents/biometric |
| `biometric.consent.revoked` | `revokeConsent` | Successful DELETE /v1/consents/biometric/:id |
| `biometric.consent.revoke.denied` | route | DELETE without valid cookie/auth proof |
| `consent.suspicious_reuse` | `verifyConsent` | Hard mismatch on (ip_hash, user_agent) soft-bind |
| `consent.qdrant_drop_failed` | `revokeConsent` | Qdrant `deleteCollection` raised, swallowed so DB revocation still proceeds |
| `biometric.search.face` | `runFaceSearch` | Successful POST /v1/events/:eventId/search/face |
| `biometric.search.face.denied` | `runFaceSearch` | Consent verify failed, OR event not published / face-search disabled |

## Selfie image handling — defence in depth

The most defamatory failure mode would be persisting the selfie image. The
design forbids it; the test `apps/api/test/face-search.service.test.ts`
"selfie bytes are never persisted to fs or S3" guards it:

1. `apps/api/src/routes/search-face.ts` reads the multipart part into a
   `Buffer` via `@fastify/multipart` `part.toBuffer()` with
   `limits: { fileSize: 8 MiB, files: 1 }`. No `attachFieldsToBody`, no
   `file.toFile`, no temp-file fallback.
2. `apps/api/src/services/face-search.ts` validates magic bytes, then calls
   `embedSelfie(buffer, ...)`.
3. `apps/api/src/lib/inference-client.ts` posts the buffer as a `Blob` to
   the Python inference service over HTTPS. No fs, no S3.
4. The route handler nulls the buffer reference in its `finally` block.

## Right-to-erasure latency

The plan and code commit to synchronous purge inside `revokeConsent`. F1.35
retention cron is the catch-all backstop for vectors whose owner did not
revoke before retention expired. See `docs/compliance-retention.md` for the
cron contract.

## Open follow-ups

- F1.36 — OpenAPI documentation of the new endpoints (deferred from this PR).
- F3.7 — per-subject cascade for right-to-erasure across all events (this
  PR covers the grantor's own consent only).
- Production-grade `IP_HASH_SALT` rotation runbook.
