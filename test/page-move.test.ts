import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { ACCOUNT, commentMark, doc, makePage, paragraph, SPACE_ID, START_TIME, text } from './fake-docmost.ts';
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

test('list_trash lists the top deleted page of each deleted subtree, newest first, with who deleted it', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'old', deletedAt: '2026-11-24T10:00:00.000Z' }),
    makePage({ id: 'p1', deletedAt: '2026-11-26T10:00:00.000Z' }),
    makePage({ id: 'c1', parentPageId: 'p1', deletedAt: '2026-11-26T10:00:00.000Z' }),
    makePage({ id: 'live' }),
    makePage({ id: 'elsewhere', spaceId: OTHER_SPACE_ID, deletedAt: '2026-11-26T11:00:00.000Z' }),
  ]);

  const result = await server.call('list_trash', { spaceId: SPACE_ID });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(JSON.parse(result.text), {
    pages: [
      { id: 'p1', slugId: 'Sp1', title: 'Page p1', parentPageId: null, deletedAt: '2026-11-26T10:00:00.000Z', deletedBy: ACCOUNT.name, url: `${docmost.url}/p/Sp1` },
      { id: 'old', slugId: 'Sold', title: 'Page old', parentPageId: null, deletedAt: '2026-11-24T10:00:00.000Z', deletedBy: ACCOUNT.name, url: `${docmost.url}/p/Sold` },
    ],
    nextCursor: null,
  });
});

test("list_trash reports Docmost's refusal for an account that can only view the space", async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', deletedAt: START_TIME })]);
  docmost.makeSpaceViewer();

  const result = await server.call('list_trash', { spaceId: SPACE_ID });
  assert.equal(result.isError, true);
  assert.match(result.text, /\/pages\/trash failed \(403\)/);
});

test('duplicate_page copies a page and its subpages next to the original as "Copy of" its title', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1', title: 'Runbook' }),
    makePage({ id: 'c1', parentPageId: 'p1' }),
    makePage({ id: 'trashedChild', parentPageId: 'p1', deletedAt: START_TIME }),
  ]);

  const result = await server.call('duplicate_page', { pageId: `${docmost.url}/p/runbook-Sp1` });
  assert.equal(result.isError, false, result.text);
  const copy = JSON.parse(result.text);
  assert.equal(copy.title, 'Copy of Runbook');
  assert.equal(copy.spaceId, SPACE_ID);
  assert.equal(copy.parentPageId, null);
  assert.equal(copy.subpagesCopied, 1);
  assert.equal(copy.moveFailed, undefined);
  assert.deepEqual(docmost.requests.filter((entry) => entry.endpoint === '/pages/duplicate').map((entry) => entry.body), [{ pageId: 'p1' }]);
  assert.equal(docmost.page('c1')?.parentPageId, 'p1');
  assert.ok(docmost.page('c1-copy4'), 'the subpage is copied once, the trashed one not at all');
  assert.equal(docmost.page('c1-copy4')?.parentPageId, copy.id);
  assert.equal(docmost.page('trashedChild-copy4'), undefined);
});

test('duplicate_page copies into another space and under the given page there', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1', title: 'Runbook' }),
    makePage({ id: 'q1', spaceId: OTHER_SPACE_ID }),
  ]);

  const result = await server.call('duplicate_page', { pageId: 'p1', parentPageId: 'q1' });
  assert.equal(result.isError, false, result.text);
  const copy = JSON.parse(result.text);
  assert.equal(copy.title, 'Runbook');
  assert.equal(copy.spaceId, OTHER_SPACE_ID);
  assert.equal(copy.parentPageId, 'q1');
  assert.deepEqual(
    docmost.requests.filter((entry) => /^\/pages\/(duplicate|move)/.test(entry.endpoint)).map((entry) => entry.endpoint),
    ['/pages/duplicate', '/pages/move'],
  );
  assert.equal(docmost.requests.find((entry) => entry.endpoint === '/pages/duplicate')?.body.spaceId, OTHER_SPACE_ID);
});

test('duplicate_page leaves comment highlights behind, as Docmost does', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1', json: doc(paragraph(text('Ship '), text('on Monday', [commentMark('c1')]))) }),
  ]);

  const copy = JSON.parse((await server.call('duplicate_page', { pageId: 'p1' })).text);
  assert.deepEqual(docmost.page(copy.id)?.json, doc(paragraph(text('Ship '), text('on Monday'))));
  assert.deepEqual(docmost.page('p1')?.json, doc(paragraph(text('Ship '), text('on Monday', [commentMark('c1')]))));
});

test('duplicate_page reports a copy it made but could not move under the parent', async (t) => {
  const { docmost, server } = await startHarness(t, [
    makePage({ id: 'p1' }),
    makePage({ id: 'trashed', title: 'Old parent', deletedAt: START_TIME }),
  ]);

  const result = await server.call('duplicate_page', { pageId: 'p1', parentPageId: 'trashed' });
  assert.equal(result.isError, false, result.text);
  const copy = JSON.parse(result.text);
  assert.equal(copy.parentPageId, null);
  assert.match(copy.moveFailed, /^The copy was made but not moved under Old parent: .*Parent page not found/);
  assert.ok(docmost.page(copy.id));
});

test('duplicate_page refuses a parent outside the given space before copying', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1' }), makePage({ id: 'q1', spaceId: OTHER_SPACE_ID })]);

  const result = await server.call('duplicate_page', { pageId: 'p1', parentPageId: 'q1', spaceId: SPACE_ID });
  assert.equal(result.isError, true);
  assert.match(result.text, /Parent page q1 is in space space-2, not space-1/);
  assert.equal(docmost.requests.some((entry) => entry.endpoint === '/pages/duplicate'), false);
});
