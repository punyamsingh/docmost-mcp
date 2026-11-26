import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { makePage, SPACE_ID } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const OTHER_SPACE_ID = 'space-2';

const resultSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  parentPageId: z.string().nullable(),
  inTrash: z.boolean().optional(),
  note: z.string().optional(),
});

const parseResult = (text: string) => resultSchema.parse(JSON.parse(text));

const pageMoveRequests = (requests: { endpoint: string }[]) =>
  requests.map((entry) => entry.endpoint).filter((endpoint) => /^\/pages\/(move|delete|restore)/.test(endpoint));

test('moves a page by URL under a parent given by slug, after its last child', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1', position: 'a0abc' }),
    makePage({ id: 'p2', position: 'a1abc' }),
    makePage({ id: 'c1', parentPageId: 'p2', position: 'a0xyz' }),
    makePage({ id: 'c2', parentPageId: 'p2', position: 'azQ12' }),
  ]);

  const result = await server.call('move_page', { pageId: `${docmost.url}/p/page-one-Sp1`, parentPageId: 'Sp2' });
  assert.equal(result.isError, false, result.text);
  assert.equal(parseResult(result.text).parentPageId, 'p2');

  const moved = docmost.page('p1');
  assert.equal(moved?.parentPageId, 'p2');
  assert.match(moved?.position ?? '', /^b00[1-9A-Za-z]{3}$/);
  assert.deepEqual(pageMoveRequests(docmost.requests), ['/pages/move']);
});

test('moves a subpage to the root of its own space', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1', position: 'a0abc' }),
    makePage({ id: 'p2', position: 'a5abc' }),
    makePage({ id: 'c1', parentPageId: 'p1', position: 'a0xyz' }),
  ]);

  const result = await server.call('move_page', { pageId: 'c1', spaceId: SPACE_ID });
  assert.equal(result.isError, false, result.text);
  assert.equal(parseResult(result.text).parentPageId, null);
  assert.match(docmost.page('c1')?.position ?? '', /^a6[1-9A-Za-z]{3}$/);
});

test('moves a page with its subpages under a page in another space', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1', position: 'a0abc' }),
    makePage({ id: 'c1', parentPageId: 'p1', position: 'a0xyz' }),
    makePage({ id: 'q1', spaceId: OTHER_SPACE_ID, position: 'a0abc' }),
  ]);

  const result = await server.call('move_page', { pageId: 'p1', parentPageId: 'q1' });
  assert.equal(result.isError, false, result.text);
  const moved = parseResult(result.text);
  assert.equal(moved.spaceId, OTHER_SPACE_ID);
  assert.equal(moved.parentPageId, 'q1');
  assert.match(docmost.page('p1')?.position ?? '', /^a0[1-9A-Za-z]{3}$/);
  assert.equal(docmost.page('c1')?.spaceId, OTHER_SPACE_ID);
  assert.deepEqual(pageMoveRequests(docmost.requests), ['/pages/move-to-space', '/pages/move']);
});

test('moves a page to the root of another space with one request', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p2', position: 'a0abc' }),
    makePage({ id: 'p1', parentPageId: 'p2', position: 'a0abc' }),
  ]);

  const result = await server.call('move_page', { pageId: 'p1', spaceId: OTHER_SPACE_ID });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(parseResult(result.text), { id: 'p1', spaceId: OTHER_SPACE_ID, parentPageId: null });
  assert.deepEqual(pageMoveRequests(docmost.requests), ['/pages/move-to-space']);
});

test('a move needs a destination, and a parent outside the given space is refused', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1' }),
    makePage({ id: 'q1', spaceId: OTHER_SPACE_ID }),
  ]);

  const noDestination = await server.call('move_page', { pageId: 'p1' });
  assert.equal(noDestination.isError, true);
  assert.equal(noDestination.text, 'Provide parentPageId or spaceId.');

  const wrongSpace = await server.call('move_page', { pageId: 'p1', parentPageId: 'q1', spaceId: SPACE_ID });
  assert.equal(wrongSpace.isError, true);
  assert.equal(wrongSpace.text, `Parent page q1 is in space ${OTHER_SPACE_ID}, not ${SPACE_ID}.`);
  assert.deepEqual(pageMoveRequests(docmost.requests), []);
});

test("Docmost's refusal to move a page under its own subpage is reported", async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1', position: 'a0abc' }),
    makePage({ id: 'c1', parentPageId: 'p1', position: 'a0abc' }),
  ]);

  const result = await server.call('move_page', { pageId: 'p1', parentPageId: 'c1' });
  assert.equal(result.isError, true);
  assert.match(result.text, /A page cannot be moved under its descendant/);
  assert.equal(docmost.page('p1')?.parentPageId, null);
});

test('delete_page moves a page and its subpages to the trash, never permanently', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1' }),
    makePage({ id: 'c1', parentPageId: 'p1' }),
  ]);

  const result = await server.call('delete_page', { pageId: 'Sp1' });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(parseResult(result.text), { id: 'p1', spaceId: SPACE_ID, parentPageId: null, inTrash: true });
  assert.ok(docmost.page('p1')?.deletedAt);
  assert.ok(docmost.page('c1')?.deletedAt);
  const deletes = docmost.requests.filter((entry) => entry.endpoint === '/pages/delete');
  assert.deepEqual(
    deletes.map((entry) => entry.body),
    [{ pageId: 'p1' }],
  );

  const again = await server.call('delete_page', { pageId: 'p1' });
  assert.equal(again.isError, false, again.text);
  assert.equal(parseResult(again.text).note, 'The page was already in the trash.');
  assert.equal(docmost.requests.filter((entry) => entry.endpoint === '/pages/delete').length, 1);
});

test('restore_page brings a page back to its parent, or to the root when the parent is still in the trash', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1' }),
    makePage({ id: 'c1', parentPageId: 'p1' }),
    makePage({ id: 'c2', parentPageId: 'p1' }),
  ]);

  await server.call('delete_page', { pageId: 'c1' });
  const toParent = await server.call('restore_page', { pageId: 'c1' });
  assert.equal(toParent.isError, false, toParent.text);
  assert.deepEqual(parseResult(toParent.text), { id: 'c1', spaceId: SPACE_ID, parentPageId: 'p1' });
  assert.equal(docmost.page('c1')?.deletedAt, null);

  await server.call('delete_page', { pageId: 'p1' });
  const toRoot = await server.call('restore_page', { pageId: 'Sc2' });
  assert.equal(toRoot.isError, false, toRoot.text);
  const restored = parseResult(toRoot.text);
  assert.equal(restored.parentPageId, null);
  assert.equal(restored.note, 'Restored to the space root because its parent page is still in the trash.');
  assert.ok(docmost.page('p1')?.deletedAt);
});

test('restore_page refuses a page that is not in the trash', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1' })]);

  const result = await server.call('restore_page', { pageId: 'p1' });
  assert.equal(result.isError, true);
  assert.equal(result.text, 'Page p1 is not in the trash.');
  assert.deepEqual(pageMoveRequests(docmost.requests), []);
});
