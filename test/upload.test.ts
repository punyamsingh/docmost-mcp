import assert from 'node:assert/strict';
import { mkdir, mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { makePage } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const uploadResultSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  url: z.string(),
  markdown: z.string(),
});

const writeTempFile = async (name: string, contents: Uint8Array | string) => {
  const directory = await mkdtemp(join(tmpdir(), 'docmost-mcp-upload-'));
  const filePath = join(directory, name);
  await writeFile(filePath, contents);
  return filePath;
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('uploads an image to the page and returns a Markdown image', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1' })]);
  const filePath = await writeTempFile('diagram.png', PNG_BYTES);

  const result = await server.call('upload_attachment', { pageId: 'Sp1', filePath });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(uploadResultSchema.parse(JSON.parse(result.text)), {
    id: 'attachment-1',
    fileName: 'diagram.png',
    mimeType: 'image/png',
    size: PNG_BYTES.byteLength,
    url: `${docmost.url}/api/files/attachment-1/diagram.png`,
    markdown: '![diagram](/api/files/attachment-1/diagram.png)',
  });

  const [upload] = docmost.uploads();
  assert.deepEqual(upload?.fields, ['pageId', 'file']);
  assert.equal(upload?.pageId, 'p1');
  assert.equal(upload?.type, 'image/png');
  assert.deepEqual(upload?.bytes, PNG_BYTES);
});

test('other files come back as a Markdown link with the given text', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1' })]);
  const pdfPath = await writeTempFile('report.pdf', '%PDF-1.4');
  const otherPath = await writeTempFile('notes.xyz', 'data');

  const pdf = uploadResultSchema.parse(
    JSON.parse(
      (await server.call('upload_attachment', { pageId: 'p1', filePath: pdfPath, altText: 'Q3 [final]' })).text,
    ),
  );
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.equal(pdf.markdown, '[Q3 \\[final\\]](/api/files/attachment-1/report.pdf)');

  const other = uploadResultSchema.parse(
    JSON.parse((await server.call('upload_attachment', { pageId: 'p1', filePath: otherPath })).text),
  );
  assert.equal(other.markdown, '[notes.xyz](/api/files/attachment-2/notes.xyz)');
  assert.equal(docmost.uploads()[1]?.type, 'application/octet-stream');
});

test('refuses a missing path, a directory and a file over 50 MB without uploading', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1' })]);
  const directory = await mkdtemp(join(tmpdir(), 'docmost-mcp-upload-'));
  const folder = join(directory, 'folder');
  await mkdir(folder);
  const largePath = join(directory, 'large.bin');
  await writeFile(largePath, '');
  await truncate(largePath, 50 * 1024 * 1024 + 1);

  const missing = await server.call('upload_attachment', { pageId: 'p1', filePath: join(directory, 'nope.png') });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /^No file at .*nope\.png\.$/);

  const notFile = await server.call('upload_attachment', { pageId: 'p1', filePath: folder });
  assert.equal(notFile.isError, true);
  assert.match(notFile.text, /is not a file\.$/);

  const large = await server.call('upload_attachment', { pageId: 'p1', filePath: largePath });
  assert.equal(large.isError, true);
  assert.match(large.text, /uploads are limited to 50 MB\.$/);

  assert.equal(docmost.uploads().length, 0);
});

test('logs in again and resends the upload when the session expired', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1' })]);
  const filePath = await writeTempFile('photo.jpg', 'jpeg');

  await server.call('get_page', { pageId: 'p1' });
  docmost.revokeTokens();
  const result = await server.call('upload_attachment', { pageId: 'p1', filePath });
  assert.equal(result.isError, false, result.text);
  assert.equal(docmost.loginCount(), 2);
  assert.equal(docmost.uploads()[0]?.type, 'image/jpeg');
});

test('reports Docmost refusing the upload', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1' })]);
  const filePath = await writeTempFile('photo.png', PNG_BYTES);

  const result = await server.call('upload_attachment', {
    pageId: '00000000-0000-4000-8000-000000000000',
    filePath,
  });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'Docmost /files/upload failed (404): Page not found');
});
