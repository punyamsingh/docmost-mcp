import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { makePage, makeZip, readZip, SPACE_ID } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const exportResultSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  format: z.string(),
  includesChildren: z.boolean().optional(),
});

const importResultSchema = z.object({
  pages: z.array(z.object({ id: z.string(), title: z.string().nullable(), url: z.string(), children: z.number() })),
  movedUnder: z.string().optional(),
  moved: z.boolean().optional(),
  moveFailed: z.string().optional(),
});

const tempDir = () => mkdtemp(join(tmpdir(), 'docmost-mcp-transfer-'));

const zipNames = (bytes: Buffer) => {
  const entries = readZip(bytes);
  assert.ok(typeof entries !== 'string', String(entries));
  return entries.map((entry) => entry.name);
};

const IMPORT_ENDPOINTS = ['/pages/import', '/pages/import-zip', '/file-tasks/info'];

const treePages = [
  makePage({ id: 'p1', title: 'Runbook', markdown: 'Top.' }),
  makePage({ id: 'p2', title: 'Setup', parentPageId: 'p1', markdown: 'Install it.' }),
];

test('exports a page with its subpages as a .zip to a new path', async (t) => {
  const { docmost, server } = await startHarness(t, treePages);
  const outputPath = join(await tempDir(), 'out', 'runbook.zip');

  const result = await server.call('export_page', {
    pageId: 'Sp1',
    format: 'markdown',
    includeChildren: true,
    outputPath,
  });
  assert.equal(result.isError, false, result.text);
  const written = await readFile(outputPath);
  assert.deepEqual(exportResultSchema.parse(JSON.parse(result.text)), {
    path: outputPath,
    bytes: written.byteLength,
    format: 'markdown',
    includesChildren: true,
  });
  assert.deepEqual(zipNames(written), ['Runbook.md', 'Runbook/Setup.md']);
  assert.deepEqual(docmost.requests.find((entry) => entry.endpoint === '/pages/export')?.body, {
    pageId: 'p1',
    format: 'markdown',
    includeChildren: true,
    includeAttachments: false,
  });
});

test('names a single-page export after Docmost when outputPath is a folder', async (t) => {
  const { server } = await startHarness(t, treePages);
  const folder = await tempDir();

  const result = await server.call('export_page', { pageId: 'p2', format: 'html', outputPath: folder });
  assert.equal(result.isError, false, result.text);
  const exported = exportResultSchema.parse(JSON.parse(result.text));
  assert.equal(exported.path, join(folder, 'Setup.html'));
  assert.equal(exported.includesChildren, false);
  assert.equal(await readFile(exported.path, 'utf8'), '<h1>Setup</h1>\n<p>Install it.</p>');
});

test('refuses to replace an existing file unless overwrite is set', async (t) => {
  const { docmost, server } = await startHarness(t, treePages);
  const folder = await tempDir();
  const outputPath = join(folder, 'runbook.md');
  await writeFile(outputPath, 'keep me');

  const refused = await server.call('export_page', { pageId: 'p1', format: 'markdown', outputPath });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /already exists; pass overwrite: true/);
  assert.equal(await readFile(outputPath, 'utf8'), 'keep me');
  assert.equal(docmost.requests.filter((entry) => entry.endpoint === '/pages/export').length, 0);

  await writeFile(join(folder, 'Setup.md'), 'keep me too');
  const named = await server.call('export_page', { pageId: 'p2', format: 'markdown', outputPath: folder });
  assert.equal(named.isError, true);
  assert.match(named.text, /Setup\.md already exists/);
  assert.equal(await readFile(join(folder, 'Setup.md'), 'utf8'), 'keep me too');

  const replaced = await server.call('export_page', { pageId: 'p1', format: 'markdown', outputPath, overwrite: true });
  assert.equal(replaced.isError, false, replaced.text);
  assert.equal(await readFile(outputPath, 'utf8'), '# Runbook\n\nTop.');
});

test('exports a space as a .zip only for a space admin', async (t) => {
  const { docmost, server } = await startHarness(t, treePages);
  const folder = await tempDir();

  const refused = await server.call('export_space', { spaceId: SPACE_ID, format: 'markdown', outputPath: folder });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /needs space admin rights.*Forbidden.*Nothing was written/);
  assert.deepEqual(await readdir(folder), []);

  docmost.makeSpaceAdmin();
  const result = await server.call('export_space', { spaceId: SPACE_ID, format: 'markdown', outputPath: folder });
  assert.equal(result.isError, false, result.text);
  const exported = exportResultSchema.parse(JSON.parse(result.text));
  assert.equal(exported.path, join(folder, 'General.zip'));
  assert.deepEqual(zipNames(await readFile(exported.path)), ['Runbook.md', 'Runbook/Setup.md']);
});

test('imports one .md file under parentPageId', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', title: 'Guides' })]);
  const filePath = join(await tempDir(), 'deploy.md');
  await writeFile(filePath, '# Deploying\n\nRun the script.');

  const result = await server.call('import_pages', { path: filePath, parentPageId: 'Sp1' });
  assert.equal(result.isError, false, result.text);
  const imported = importResultSchema.parse(JSON.parse(result.text));
  assert.deepEqual(imported, {
    pages: [{ id: 'imported2', title: 'Deploying', url: `${docmost.url}/p/Simported2`, children: 0 }],
    movedUnder: 'p1',
  });
  assert.equal(docmost.page('imported2')?.parentPageId, 'p1');
  assert.deepEqual(docmost.requests.find((entry) => entry.endpoint === '/pages/import')?.body, {
    spaceId: SPACE_ID,
    file: 'deploy.md',
  });
});

test('zips a folder, imports it nested by folder, and moves it under the parent', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', title: 'Guides' })]);
  const folder = join(await tempDir(), 'docs');
  await mkdir(join(folder, 'guide'), { recursive: true });
  await writeFile(join(folder, 'guide.md'), '# Guide\n\nSee [setup](guide/setup.md).');
  await writeFile(join(folder, 'guide', 'setup.md'), 'Install it.\n\n![diagram](diagram.png)');
  await writeFile(join(folder, 'guide', 'diagram.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(folder, '.DS_Store'), 'junk');

  const result = await server.call('import_pages', { path: folder, parentPageId: 'p1' });
  assert.equal(result.isError, false, result.text);
  const imported = importResultSchema.parse(JSON.parse(result.text));
  assert.deepEqual(imported, {
    pages: [{ id: 'imported2', title: 'Guide', url: `${docmost.url}/p/Simported2`, children: 1 }],
    movedUnder: 'p1',
  });
  assert.equal(docmost.page('imported2')?.parentPageId, 'p1');
  assert.equal(docmost.page('imported3')?.title, 'setup');
  assert.equal(docmost.page('imported3')?.parentPageId, 'imported2');
  assert.deepEqual(docmost.importedAttachments(), ['docs/guide/diagram.png']);

  const [task] = docmost.fileTasks();
  assert.ok(task);
  assert.deepEqual(zipNames(task.zip).sort(), ['docs/guide.md', 'docs/guide/diagram.png', 'docs/guide/setup.md']);
  assert.deepEqual(docmost.requests.find((entry) => entry.endpoint === '/pages/import-zip')?.body, {
    spaceId: SPACE_ID,
    source: 'generic',
    file: 'docs.zip',
  });
});

test('imports a .zip to the space root with every new root page', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', title: 'Existing' })]);
  const zipPath = join(await tempDir(), 'handbook.zip');
  await writeFile(
    zipPath,
    makeZip([
      { name: 'faq.md', contents: Buffer.from('Questions.') },
      { name: 'team/people.md', contents: Buffer.from('People.') },
    ]),
  );

  const result = await server.call('import_pages', { path: zipPath, spaceId: SPACE_ID });
  assert.equal(result.isError, false, result.text);
  const imported = importResultSchema.parse(JSON.parse(result.text));
  assert.deepEqual(
    imported.pages.map((page) => [page.title, page.children]),
    [
      ['faq', 0],
      ['team', 1],
    ],
  );
  assert.equal(imported.movedUnder, undefined);
  assert.deepEqual(
    imported.pages.map((page) => docmost.page(page.id)?.parentPageId),
    [null, null],
  );
});

test('returns the task id when the import is still running after the wait', async (t) => {
  const { docmost, server } = await startHarness(t, [], { env: { DOCMOST_IMPORT_WAIT_SECONDS: '1' } });
  docmost.setImportMode('hang');
  const zipPath = join(await tempDir(), 'big.zip');
  await writeFile(zipPath, makeZip([{ name: 'big.md', contents: Buffer.from('Big.') }]));

  const result = await server.call('import_pages', { path: zipPath, spaceId: SPACE_ID });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(JSON.parse(result.text), {
    fileTaskId: 'file-task-1',
    stillImporting:
      "Docmost is still importing big.zip after 1 s; its pages will appear at the end of the space's root pages.",
  });
  assert.ok(docmost.requests.some((entry) => entry.endpoint === '/file-tasks/info'));
});

test('refuses a failed task, a missing path and Enterprise-only file types', async (t) => {
  const { docmost, server } = await startHarness(t, []);
  const folder = await tempDir();
  const docxPath = join(folder, 'plan.docx');
  const otherPath = join(folder, 'notes.txt');
  await writeFile(docxPath, 'PK');
  await writeFile(otherPath, 'notes');

  const missing = await server.call('import_pages', { path: join(folder, 'nope.md'), spaceId: SPACE_ID });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /nothing at .*nope\.md\. Nothing was created/);
  const docx = await server.call('import_pages', { path: docxPath, spaceId: SPACE_ID });
  assert.equal(docx.isError, true);
  assert.match(docx.text, /\.docx files needs Docmost Enterprise/);
  const other = await server.call('import_pages', { path: otherPath, spaceId: SPACE_ID });
  assert.equal(other.isError, true);
  assert.match(other.text, /takes a \.md, \.html or \.zip file or a folder/);
  const empty = await server.call('import_pages', { path: await tempDir(), spaceId: SPACE_ID });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /holds no \.md or \.html files/);
  assert.equal(docmost.requests.filter((entry) => IMPORT_ENDPOINTS.includes(entry.endpoint)).length, 0);

  docmost.setImportMode('fail');
  const zipPath = join(folder, 'broken.zip');
  await writeFile(zipPath, makeZip([{ name: 'broken.md', contents: Buffer.from('Broken.') }]));
  const failed = await server.call('import_pages', { path: zipPath, spaceId: SPACE_ID });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /could not import broken\.zip: File import failed: Unexpected end of archive/);
  assert.deepEqual(docmost.pages(), []);
});

test('returns the imported pages with moved: false when the move fails', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', title: 'Guides' })]);
  docmost.rejectMoves(403, 'Forbidden');
  const filePath = join(await tempDir(), 'deploy.md');
  await writeFile(filePath, 'Run the script.');

  const result = await server.call('import_pages', { path: filePath, parentPageId: 'p1' });
  assert.equal(result.isError, false, result.text);
  const imported = importResultSchema.parse(JSON.parse(result.text));
  assert.deepEqual(imported.pages, [
    { id: 'imported2', title: 'deploy', url: `${docmost.url}/p/Simported2`, children: 0 },
  ]);
  assert.equal(imported.moved, false);
  assert.match(imported.moveFailed ?? '', /0 of 1 moved under Guides before a move failed: .*Forbidden/);
  assert.equal(docmost.page('imported2')?.parentPageId, null);
});
