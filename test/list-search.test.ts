import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPACE_ID, makePage } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const manyPages = (count: number) => Array.from({ length: count }, (_, index) => makePage({ id: `p${index + 1}` }));

test('list_pages returns root pages with updatedAt, and the children of a page', async (t) => {
  const { server } = await startHarness(t, [
    makePage({ id: 'root', updatedAt: '2026-11-20T08:00:00.000Z' }),
    makePage({ id: 'child', parentPageId: 'root' }),
  ]);

  const roots = JSON.parse((await server.call('list_pages', { spaceId: SPACE_ID })).text);
  assert.deepEqual(
    roots.map((page: { id: string; hasChildren: boolean; updatedAt: string }) => [
      page.id,
      page.hasChildren,
      page.updatedAt,
    ]),
    [['root', true, '2026-11-20T08:00:00.000Z']],
  );

  const children = JSON.parse((await server.call('list_pages', { parentPageId: 'Sroot' })).text);
  assert.deepEqual(
    children.map((page: { id: string }) => page.id),
    ['child'],
  );
});

test('list_pages reports updatedAt as null when Docmost does not return it', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'root' })], { sidebarWithoutUpdatedAt: true });

  const [page] = JSON.parse((await server.call('list_pages', { spaceId: SPACE_ID })).text);
  assert.equal(page.id, 'root');
  assert.equal(page.updatedAt, null);
});

test('list_pages says when it stopped at the item cap', async (t) => {
  const { server } = await startHarness(t, manyPages(1001));

  const result = await server.call('list_pages', { spaceId: SPACE_ID });
  const [json, note] = result.text.split('\n\n[');
  assert.equal(JSON.parse(json ?? '').length, 1000);
  assert.equal(note, 'first 1000 pages only; the rest were not fetched]');
});

test('list_pages never returns more than the cap, even from a batch larger than asked for', async (t) => {
  const exact = await startHarness(t, manyPages(1000), { sidebarPageSize: 200 });
  const exactResult = await exact.server.call('list_pages', { spaceId: SPACE_ID });
  assert.equal(JSON.parse(exactResult.text).length, 1000);

  const over = await startHarness(t, manyPages(1100), { sidebarPageSize: 300 });
  const overResult = await over.server.call('list_pages', { spaceId: SPACE_ID });
  const [json, note] = overResult.text.split('\n\n[');
  assert.equal(JSON.parse(json ?? '').length, 1000);
  assert.equal(note, 'first 1000 pages only; the rest were not fetched]');
});

test('list_spaces lists every space, and says when it stopped at the item cap', async (t) => {
  const spaces = Array.from({ length: 1001 }, (_, index) => ({
    id: `s${index}`,
    name: `Space ${index}`,
    slug: `s${index}`,
  }));
  const { server } = await startHarness(t, [], { spaces });

  const result = await server.call('list_spaces');
  assert.match(result.text, /\n\n\[first 1000 spaces only; the rest were not fetched\]$/);

  const { server: smallServer } = await startHarness(t, []);
  assert.deepEqual(JSON.parse((await smallServer.call('list_spaces')).text), [
    { id: SPACE_ID, name: 'General', slug: 'general' },
  ]);
});

test('search_pages returns spaceId and updatedAt, and pages through results by offset', async (t) => {
  const { docmost, server } = await startHarness(t, manyPages(5));

  const first = await server.call('search_pages', { query: 'page', limit: 2 });
  const [json, note] = first.text.split('\n\n[');
  const results = JSON.parse(json ?? '');
  assert.deepEqual(
    results.map((result: { id: string; spaceId: string; space: string; updatedAt: string }) => [
      result.id,
      result.spaceId,
      result.space,
      result.updatedAt,
    ]),
    [
      ['p1', SPACE_ID, 'General', '2026-11-25T10:00:00.000Z'],
      ['p2', SPACE_ID, 'General', '2026-11-25T10:00:00.000Z'],
    ],
  );
  assert.equal(note, 'call search_pages with offset 2 for more]');

  const last = await server.call('search_pages', { query: 'page', limit: 2, offset: 4 });
  assert.deepEqual(
    JSON.parse(last.text).map((result: { id: string }) => result.id),
    ['p5'],
  );
  assert.deepEqual(
    docmost.requests.filter((request) => request.endpoint === '/search').map((request) => request.body.offset),
    [0, 4],
  );
});
