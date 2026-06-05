// F4.4 — Google Drive cloud-storage adapter.
//
// Lists image files in a folder (paginated, shared-drive aware) and opens a
// streaming download via alt=media. The access token is supplied by the worker
// (refreshed + persisted out-of-band); this adapter holds no token cache. HTTP
// and the byte downloader are injected so this is fixture-testable. Drive
// response shapes follow the v3 API but are NOT live-verified in this
// environment.

import { cloudErrorForStatus } from './retry.js';
import type {
  CloudDownload,
  CloudDownloader,
  CloudFile,
  CloudHttpClient,
  CloudStorageAdapter,
  ListFolderOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://www.googleapis.com/drive/v3';
const PAGE_SIZE = 1000;

export interface GoogleDriveOptions {
  accessToken: string;
  httpClient: CloudHttpClient;
  downloader: CloudDownloader;
  baseUrl?: string;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  md5Checksum?: string;
}

export class GoogleDriveAdapter implements CloudStorageAdapter {
  readonly provider = 'gdrive' as const;
  private readonly accessToken: string;
  private readonly http: CloudHttpClient;
  private readonly downloader: CloudDownloader;
  private readonly baseUrl: string;

  constructor(opts: GoogleDriveOptions) {
    this.accessToken = opts.accessToken;
    this.http = opts.httpClient;
    this.downloader = opts.downloader;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}`, accept: 'application/json' };
  }

  // v1 lists the folder's direct image children (non-recursive); subfolder
  // recursion is intentionally out of scope ("pick a folder").
  async listFolder(folderId: string, _opts: ListFolderOptions = {}): Promise<CloudFile[]> {
    const q = `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`;
    const files: CloudFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum)',
        pageSize: String(PAGE_SIZE),
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        spaces: 'drive',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.http(
        'GET',
        `${this.baseUrl}/files?${params.toString()}`,
        this.headers(),
      );
      if (res.status !== 200) {
        throw cloudErrorForStatus(res.status, `gdrive list ${res.status}`, res.headers, res.body);
      }
      const body = (res.body ?? {}) as { files?: DriveFile[]; nextPageToken?: string };
      for (const f of body.files ?? []) {
        if (!f.id) continue;
        files.push({
          remoteFileId: f.id,
          name: f.name ?? f.id,
          contentType: f.mimeType ?? 'application/octet-stream',
          size: f.size != null && f.size !== '' ? Number(f.size) : null,
          contentHash: f.md5Checksum ? `gdrive:md5:${f.md5Checksum}` : `gdrive:fileid:${f.id}`,
        });
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }

  async download(remoteFileId: string): Promise<CloudDownload> {
    const url = `${this.baseUrl}/files/${encodeURIComponent(remoteFileId)}?alt=media&supportsAllDrives=true`;
    const dl = await this.downloader('GET', url, { authorization: `Bearer ${this.accessToken}` });
    if (dl.status < 200 || dl.status >= 300) {
      dl.stream.destroy();
      throw cloudErrorForStatus(dl.status, `gdrive download ${dl.status}`, dl.headers);
    }
    return dl;
  }
}
