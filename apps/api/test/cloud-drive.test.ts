// F4.4 — Google Drive adapter unit tests (fixtures).

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { type CloudDownloader, type CloudHttpClient, GoogleDriveAdapter } from '@pkg/integrations';

const okDownloader: CloudDownloader = vi.fn(async () => ({
  status: 200,
  stream: Readable.from(['x']),
  headers: {},
}));

describe('GoogleDriveAdapter.listFolder', () => {
  it('follows pagination and maps files (md5 + fileid fallback)', async () => {
    const pages = [
      {
        status: 200,
        headers: {},
        body: {
          nextPageToken: 'p2',
          files: [
            { id: 'a', name: 'a.jpg', mimeType: 'image/jpeg', size: '100', md5Checksum: 'abc' },
          ],
        },
      },
      {
        status: 200,
        headers: {},
        body: { files: [{ id: 'b', name: 'b.heic', mimeType: 'image/heic' }] },
      },
    ];
    let call = 0;
    const http: CloudHttpClient = vi.fn(async () => pages[call++] ?? pages[1]!);
    const files = await new GoogleDriveAdapter({
      accessToken: 'AT',
      httpClient: http,
      downloader: okDownloader,
    }).listFolder('folder1');
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      remoteFileId: 'a',
      contentType: 'image/jpeg',
      size: 100,
      contentHash: 'gdrive:md5:abc',
    });
    expect(files[1]).toMatchObject({
      remoteFileId: 'b',
      size: null,
      contentHash: 'gdrive:fileid:b',
    });
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('restricts the query to the folder + images and bearer-auths', async () => {
    const http = vi.fn(async () => ({ status: 200, headers: {}, body: { files: [] } }));
    await new GoogleDriveAdapter({
      accessToken: 'TOK',
      httpClient: http as never,
      downloader: okDownloader,
    }).listFolder('F');
    const [m, u, h] = http.mock.calls[0] as [string, string, Record<string, string>];
    expect(m).toBe('GET');
    const q = new URL(u).searchParams.get('q') ?? '';
    expect(q).toContain("'F' in parents");
    expect(q).toContain("mimeType contains 'image/'");
    expect(u).toContain('supportsAllDrives=true');
    expect(h.authorization).toBe('Bearer TOK');
  });

  it('throws a retryable rate_limited error on a Drive 403 rate-limit body', async () => {
    const http: CloudHttpClient = vi.fn(async () => ({
      status: 403,
      headers: {},
      body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } },
    }));
    await expect(
      new GoogleDriveAdapter({
        accessToken: 'AT',
        httpClient: http,
        downloader: okDownloader,
      }).listFolder('F'),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });
});

describe('GoogleDriveAdapter.download', () => {
  const http: CloudHttpClient = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));

  it('requests alt=media with bearer auth and returns the stream', async () => {
    const dl = vi.fn(async () => ({ status: 200, stream: Readable.from(['bytes']), headers: {} }));
    const out = await new GoogleDriveAdapter({
      accessToken: 'TOK',
      httpClient: http,
      downloader: dl as never,
    }).download('fileX');
    const [m, u, h] = dl.mock.calls[0] as [string, string, Record<string, string>];
    expect(m).toBe('GET');
    expect(u).toContain('/files/fileX?alt=media');
    expect(h.authorization).toBe('Bearer TOK');
    expect(out.status).toBe(200);
  });

  it('throws on a non-2xx download', async () => {
    const dl = vi.fn(async () => ({ status: 404, stream: Readable.from(['']), headers: {} }));
    await expect(
      new GoogleDriveAdapter({
        accessToken: 'AT',
        httpClient: http,
        downloader: dl as never,
      }).download('x'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
