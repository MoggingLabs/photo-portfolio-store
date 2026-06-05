// F4.4 — build the right CloudStorageAdapter for a provider. The worker closes
// over the real HTTP client + streaming downloader and passes the per-import
// access token here.

import { DropboxAdapter } from './dropbox.js';
import { GoogleDriveAdapter } from './google-drive.js';
import type {
  CloudDownloader,
  CloudHttpClient,
  CloudProvider,
  CloudStorageAdapter,
} from './types.js';

export interface CreateCloudAdapterOptions {
  accessToken: string;
  httpClient: CloudHttpClient;
  downloader: CloudDownloader;
}

export const createCloudStorageAdapter = (
  provider: CloudProvider,
  opts: CreateCloudAdapterOptions,
): CloudStorageAdapter => {
  if (provider === 'gdrive') return new GoogleDriveAdapter(opts);
  return new DropboxAdapter(opts);
};
