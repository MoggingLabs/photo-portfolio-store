// F4.4 — Dropbox cloud-storage adapter.
//
// Lists image files in a folder (cursor pagination) and opens a streaming
// download. Dropbox returns no MIME type, so contentType is derived from the
// file extension. Files without a recognized photo extension are skipped (the
// Drive adapter's `mimeType contains 'image/'` filter does the same); a
// recognized-but-pipeline-unsupported type (HEIF/WEBP/RAW) IS surfaced and the
// worker records it failed. Response shapes follow the Dropbox v2 API but are
// NOT live-verified in this environment.

import { cloudErrorForStatus } from './retry.js';
import type {
  CloudDownload,
  CloudDownloader,
  CloudFile,
  CloudHttpClient,
  CloudStorageAdapter,
  ListFolderOptions,
} from './types.js';

const DEFAULT_API_BASE_URL = 'https://api.dropboxapi.com/2';
const DEFAULT_CONTENT_BASE_URL = 'https://content.dropboxapi.com/2';
const PAGE_LIMIT = 2000;

// Photo extensions worth importing. RAW/TIFF are included so the user sees them
// attempted; the worker's allowed-type gate records unsupported ones as failed.
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  cr2: 'application/octet-stream',
  cr3: 'application/octet-stream',
  nef: 'application/octet-stream',
  arw: 'application/octet-stream',
  dng: 'application/octet-stream',
  raf: 'application/octet-stream',
  orf: 'application/octet-stream',
  rw2: 'application/octet-stream',
};

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

export interface DropboxOptions {
  accessToken: string;
  httpClient: CloudHttpClient;
  downloader: CloudDownloader;
  apiBaseUrl?: string;
  contentBaseUrl?: string;
}

interface DropboxEntry {
  '.tag'?: string;
  id?: string;
  name?: string;
  content_hash?: string;
  size?: number;
}

export class DropboxAdapter implements CloudStorageAdapter {
  readonly provider = 'dropbox' as const;
  private readonly accessToken: string;
  private readonly http: CloudHttpClient;
  private readonly downloader: CloudDownloader;
  private readonly apiBaseUrl: string;
  private readonly contentBaseUrl: string;

  constructor(opts: DropboxOptions) {
    this.accessToken = opts.accessToken;
    this.http = opts.httpClient;
    this.downloader = opts.downloader;
    this.apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
    this.contentBaseUrl = (opts.contentBaseUrl ?? DEFAULT_CONTENT_BASE_URL).replace(/\/$/, '');
  }

  private jsonHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  async listFolder(folderId: string, opts: ListFolderOptions = {}): Promise<CloudFile[]> {
    const files: CloudFile[] = [];
    let res = await this.http('POST', `${this.apiBaseUrl}/files/list_folder`, this.jsonHeaders(), {
      path: folderId,
      recursive: opts.recursive ?? false,
      limit: PAGE_LIMIT,
    });
    for (;;) {
      if (res.status !== 200) {
        throw cloudErrorForStatus(res.status, `dropbox list ${res.status}`, res.headers, res.body);
      }
      const body = (res.body ?? {}) as {
        entries?: DropboxEntry[];
        cursor?: string;
        has_more?: boolean;
      };
      for (const e of body.entries ?? []) {
        if (e['.tag'] !== 'file' || !e.id) continue;
        const ext = extOf(e.name ?? '');
        const contentType = EXT_MIME[ext];
        if (!contentType) continue; // not a photo file — skip
        files.push({
          remoteFileId: e.id,
          name: e.name ?? e.id,
          contentType,
          size: typeof e.size === 'number' ? e.size : null,
          contentHash: e.content_hash ? `dropbox:${e.content_hash}` : `dropbox:fileid:${e.id}`,
        });
      }
      if (!body.has_more || !body.cursor) break;
      res = await this.http(
        'POST',
        `${this.apiBaseUrl}/files/list_folder/continue`,
        this.jsonHeaders(),
        {
          cursor: body.cursor,
        },
      );
    }
    return files;
  }

  async download(remoteFileId: string): Promise<CloudDownload> {
    const dl = await this.downloader('POST', `${this.contentBaseUrl}/files/download`, {
      authorization: `Bearer ${this.accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path: remoteFileId }),
    });
    if (dl.status < 200 || dl.status >= 300) {
      dl.stream.destroy();
      throw cloudErrorForStatus(dl.status, `dropbox download ${dl.status}`, dl.headers);
    }
    return dl;
  }
}
