# Google Drive / Dropbox import (F4.4)

Photographers connect a cloud account once, bind an event folder, and a worker
streams every supported photo into the normal ingest pipeline — no re-upload.
The connection (access + refresh token) is stored **per org** in
`integration_configs` (type `gdrive`/`dropbox`), envelope-encrypted (F4.1). A
folder→event binding is a `cloud_imports` row; the per-file resume state lives in
`cloud_import_files`.

## What the app does

- `POST /v1/orgs/:orgId/integrations/:provider/connect` (`integrations:manage`)
  returns the provider authorize URL with an HMAC-signed `state`
  (`{orgId, userId, provider, exp}`). Google uses `access_type=offline&prompt=consent`,
  Dropbox `token_access_type=offline`, so a refresh token is always issued.
- `GET /v1/integrations/:provider/callback` is **public** (a browser redirect from
  the provider; no bearer auth — exempt in `auth/rbac.ts`). It verifies the
  `state`, exchanges the `code` for tokens, stores them encrypted+enabled, and
  302-redirects to the app. The initiating org/user come from the signed state,
  never the session.
- `POST /v1/events/:id/imports` (`event:write`, body `{provider, remoteFolderId}`)
  requires a connected provider for the event's org (409 otherwise) and creates a
  `pending` import.
- `GET /v1/events/:id/imports/:importId` (`event:write`) returns
  files-imported / total + a linear ETA.
- The worker sweep (`apps/worker/src/jobs/cloud-import.ts`, every 5 min) lists the
  folder once, seeds a row per file, then streams a bounded batch per tick: download
  → R2 (`@aws-sdk/lib-storage`, no full buffering) → `photos` row (`processing`) →
  ingest fan-out → mark `imported`. Tokens are decrypted in-process and refreshed
  (+ re-encrypted) when near expiry.

## Resumability, dedup, and counters

- Dedup/resume is scoped to `(cloud_import_id, content_hash)` where the hash is the
  provider-supplied fingerprint (Drive `md5Checksum`, Dropbox `content_hash`),
  falling back to the remote file id. A file is marked `imported` **only after** its
  ingest job is enqueued, so a crash mid-file retries cleanly next tick.
- Counters are recomputed from the file rows each tick; the import finalizes to
  `completed` only when nothing is `pending`. Transient download/upload failures
  retry up to 5 attempts; a `429`/Retry-After stops the tick and resumes later.

## Supported file types

Same as direct upload: `image/jpeg`, `image/png`, `image/heic`. Other types
(HEIF, TIFF, WEBP, RAW) are listed but recorded as `failed` with
`unsupported_type` — broadening the ingest/derivatives pipeline to RAW/HEIF is a
future enhancement, tracked separately. Files Drive/Dropbox report without a size
are recorded `failed` with `missing_size` (we never buffer to learn the size).

## What the deploy must provide

1. **OAuth apps.** Register a Google Cloud OAuth client (enable the Drive API,
   scope `https://www.googleapis.com/auth/drive.readonly`) and a Dropbox app
   (scopes `files.metadata.read files.content.read`). Set each redirect URI to
   `${API_BASE_URL}/v1/integrations/<provider>/callback`.
2. **Env (all optional; the feature is off until set).** API + worker:
   `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`,
   `DROPBOX_OAUTH_CLIENT_ID` / `DROPBOX_OAUTH_CLIENT_SECRET`. API also:
   `CLOUD_IMPORT_STATE_SECRET` (a 32+ byte random string; falls back to
   `GALLERY_TOKEN_SECRET`, which must itself be high-entropy), `API_BASE_URL`,
   `APP_BASE_URL`. Both already need `INTEGRATIONS_MASTER_KEY`.
   `connect` answers `503 not_configured` until a provider is fully configured.
3. **Refresh-token longevity.** Google issues a refresh token only on first
   consent; the refresh path **merges** (keeps the prior refresh token when a
   response omits one). Revoking access in the provider's account settings
   invalidates the connection — the user reconnects to re-issue tokens.

## Not runtime-verified here

Live OAuth consent and real folder listing/download require Google/Dropbox apps +
accounts that are not available in this environment. Everything app-side —
provider response mapping + pagination, the resume state machine, token-refresh
merge, 429/Retry-After backoff, OAuth state sign/verify, route RBAC, and the
stream-upload→ingest hand-off — is unit-tested with injected stubs.
