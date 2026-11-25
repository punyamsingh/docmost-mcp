import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePage } from './fake-docmost.ts';
import { readPageResult, startHarness } from './helpers.ts';

const numberedLines = (count: number, first = 1) =>
  Array.from({ length: count }, (_, index) => `line ${first + index}`).join('\n');

test('returns 500 lines by default and the rest from an offset', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: numberedLines(1200) })]);

  const first = await server.call('get_page', { pageId: 'p1' });
  const firstWindow = readPageResult(first.text);
  assert.equal(firstWindow.header.totalLines, 1200);
  assert.equal(firstWindow.header.nextOffset, 501);
  assert.equal(
    firstWindow.body,
    `${numberedLines(500)}\n\n[lines 1–500 of 1200; call get_page with offset 501 for more]`,
  );

  const last = readPageResult((await server.call('get_page', { pageId: 'p1', offset: 1001 })).text);
  assert.equal(last.header.nextOffset, null);
  assert.equal(last.body, numberedLines(200, 1001));
});

test('an offset past the end returns an empty body, not an error', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: numberedLines(30) })]);

  const result = await server.call('get_page', { pageId: 'p1', offset: 5000 });
  assert.equal(result.isError, false);
  const window = readPageResult(result.text);
  assert.equal(window.body, '');
  assert.equal(window.header.totalLines, 30);
  assert.equal(window.header.nextOffset, null);
});

test('the window stops under 100k characters at a line boundary', async (t) => {
  const longLine = 'a'.repeat(60_000);
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: `${longLine}\n${longLine}\nshort` })]);

  const window = readPageResult((await server.call('get_page', { pageId: 'p1' })).text);
  assert.equal(window.header.nextOffset, 2);
  assert.ok(window.body.startsWith(`${longLine}\n\n[lines 1–1 of 3;`));
});

test('a single line over 100k characters is cut at 100k', async (t) => {
  const { server } = await startHarness(t, [makePage({ id: 'p1', markdown: `${'b'.repeat(150_000)}\nnext` })]);

  const window = readPageResult((await server.call('get_page', { pageId: 'p1' })).text);
  assert.equal(window.header.nextOffset, 2);
  assert.ok(window.body.startsWith(`${'b'.repeat(100_000)}\n\n[lines 1–1 of 2;`));
});

test('accepts a page id, a slug id or a copied page URL', async (t) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', markdown: 'hello' })]);

  for (const pageId of ['p1', 'Sp1', `${docmost.url}/p/my-page-title-Sp1`]) {
    const window = readPageResult((await server.call('get_page', { pageId })).text);
    assert.equal(window.header.id, 'p1');
    assert.equal(window.body, 'hello');
  }
});
