// F4.4 — Dropbox adapter unit tests (fixtures).

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { type CloudDownloader, DropboxAdapter } from '@pkg/integrations';

const okDownloader: CloudDownloader = vi.fn(async () => ({
  status: 200,
  stream: Readable.from(['x']),
  headers: {},
}));

describe('DropboxAdapter.listFolder', () => {
  it('follows cursor pagination, filters non-photos, maps content_hash', async () => {
    const page1 = {
      status: 200,
      headers: {},
      body: {
        has_more: true,
        cursor: 'C1',
        entries: [
          { '.tag': 'file', id: 'id:a', name: 'a.JPG', content_hash: 'h1', size: 10 },
          { '.tag': 'folder', id: 'id:f', name: 'sub' },
          { '.tag': 'file', id: 'id:doc', name: 'notes.txt', content_hash: 'h2', size: 5 },
        ],
      },
    };
    const page2 = {
      status: 200,
      headers: {},
      body: { has_more: false, entries: [{ '.tag': 'file', id: 'id:b', name: 'b.cr2', size: 20 }] },
    };
    const http = vi.fn(async (_m: string, url: string) =>
      url.includes('/continue') ? page2 : page1,
    );
    const files = await new DropboxAdapter({
      accessToken: 'AT',
      httpClient: http as never,
      downloader: okDownloader,
    }).listFolder('/Event');
    // The .txt and the folder are skipped; both pages are walked.
    expect(files.map((f) => f.remoteFileId)).toEqual(['id:a', 'id:b']);
    expect(files[0]).toMatchObject({
      contentType: 'image/jpeg',
      size: 10,
      contentHash: 'dropbox:h1',
    });
    expect(files[1]).toMatchObject({
      contentType: 'application/octet-stream',
      contentHash: 'dropbox:fileid:id:b',
    });
  });

  it('sends path + recursive to list_folder with bearer auth', async () => {
    const http = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { entries: [], has_more: false },
    }));
    await new DropboxAdapter({
      accessToken: 'AT',
      httpClient: http as never,
      downloader: okDownloader,
    }).listFolder('/E', { recursive: true });
    const [m, u, h, b] = http.mock.calls[0] as [string, string, Record<string, string>, unknown];
    expect(m).toBe('POST');
    expect(u).toContain('/files/list_folder');
    expect(h.authorization).toBe('Bearer AT');
    expect(b).toMatchObject({ path: '/E', recursive: true });
  });
});

describe('DropboxAdapter.download', () => {
  it('POSTs to /files/download with the path in Dropbox-API-Arg', async () => {
    const dl = vi.fn(async () => ({ status: 200, stream: Readable.from(['x']), headers: {} }));
    const http = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    await new DropboxAdapter({
      accessToken: 'AT',
      httpClient: http as never,
      downloader: dl as never,
    }).download('id:z');
    const [m, u, h] = dl.mock.calls[0] as [string, string, Record<string, string>];
    expect(m).toBe('POST');
    expect(u).toContain('/files/download');
    expect(JSON.parse(h['Dropbox-API-Arg'] ?? '{}')).toMatchObject({ path: 'id:z' });
  });
});
