// F4.4 — cloud-storage (Google Drive / Dropbox) adapter interface.
//
// A cloud provider exposes a folder of photos that the import worker enumerates
// and streams into ingest. Each provider implements CloudStorageAdapter so the
// worker stays provider-agnostic. OAuth token exchange/refresh are standalone
// functions rather than adapter methods: the worker persists tokens in
// integration_configs between cron runs, so there is no in-adapter token cache
// (unlike the timing MyLaps client-credentials adapter).

import type { Readable } from 'node:stream';

export type CloudProvider = 'gdrive' | 'dropbox';

// A file discovered in the remote folder. `contentHash` is the namespaced dedup
// key (e.g. 'gdrive:md5:<hex>', 'dropbox:<content_hash>'), falling back to the
// remote file id ('gdrive:fileid:<id>') when the provider exposes no hash.
export interface CloudFile {
  remoteFileId: string;
  name: string;
  contentType: string;
  // Byte size from provider metadata; null when the provider omits it. The
  // worker skips such files rather than buffering the bytes to learn the size,
  // since photos.original_bytes is NOT NULL.
  size: number | null;
  contentHash: string;
}

// A streaming download handle — the worker pipes `stream` straight to R2 via
// @aws-sdk/lib-storage, so RAW files are never fully buffered in memory.
export interface CloudDownload {
  status: number;
  stream: Readable;
  headers: Record<string, string>;
}

export interface ListFolderOptions {
  // Recurse into subfolders (default false).
  recursive?: boolean;
}

export interface CloudStorageAdapter {
  readonly provider: CloudProvider;
  // Enumerate image files in the folder, following provider pagination.
  listFolder(folderId: string, opts?: ListFolderOptions): Promise<CloudFile[]>;
  // Open a streaming download for a file (no full-file buffering).
  download(remoteFileId: string): Promise<CloudDownload>;
}

export type CloudErrorCode = 'auth' | 'rate_limited' | 'not_found' | 'transient' | 'invalid';

export class CloudStorageError extends Error {
  constructor(
    public readonly code: CloudErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    // Milliseconds to wait before retrying, parsed from Retry-After when present.
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'CloudStorageError';
  }
}

// OAuth token set, persisted envelope-encrypted in integration_configs.
export interface CloudTokenSet {
  accessToken: string;
  refreshToken: string;
  // Unix seconds at which the access token expires.
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  // The registered redirect URI; required by both providers on token exchange.
  redirectUri: string;
}

// Injectable JSON HTTP client (same shape as the timing/print adapters, plus
// response headers for Retry-After). Used for folder listing, metadata, and
// OAuth token exchange/refresh. Downloads use the streaming path below.
export interface CloudHttpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export type CloudHttpMethod = 'GET' | 'POST';

export type CloudHttpClient = (
  method: CloudHttpMethod,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
) => Promise<CloudHttpResponse>;

// Injectable streaming downloader (undici `request` in production, a PassThrough
// in tests). Returns the raw byte stream plus status + response headers. Takes a
// method because Drive downloads are GET (alt=media) while Dropbox downloads are
// POST with the file path in a Dropbox-API-Arg header.
export type CloudDownloader = (
  method: CloudHttpMethod,
  url: string,
  headers: Record<string, string>,
) => Promise<CloudDownload>;
