import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePage, START_TIME } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const page = () => makePage({ id: 'p1', markdown: 'original body' });

test('a replace with an old expectedUpdatedAt is refused and nothing is written', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', {
    pageId: 'p1',
    markdown: 'new body',
    expectedUpdatedAt: '2026-11-25T09:00:00.000Z',
  });
  assert.equal(result.isError, true);
  assert.match(result.text, new RegExp(`Page changed at ${START_TIME} \\(you read 2026-11-25T09:00:00.000Z\\)`));
  assert.equal(docmost.writes().length, 0);
});

test('the same timestamp written with +00:00 counts as unchanged', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', {
    pageId: 'p1',
    markdown: 'new body',
    expectedUpdatedAt: '2026-11-25T10:00:00.000+00:00',
  });
  assert.equal(result.isError, false);
  assert.equal(docmost.page('p1')?.markdown, 'new body');
  assert.equal(JSON.parse(result.text).updatedAt, docmost.page('p1')?.updatedAt);
});

test('a value that is not a timestamp is refused before any request', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', { pageId: 'p1', markdown: 'new body', expectedUpdatedAt: 'yesterday' });
  assert.equal(result.isError, true);
  assert.match(result.text, /expectedUpdatedAt "yesterday" is not a timestamp/);
  assert.equal(docmost.requests.length, 0);
});

test('an append ignores expectedUpdatedAt', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', {
    pageId: 'p1',
    markdown: 'more',
    operation: 'append',
    expectedUpdatedAt: '2026-11-25T09:00:00.000Z',
  });
  assert.equal(result.isError, false);
  assert.equal(docmost.page('p1')?.markdown, 'original body\n\nmore');
});

test('a replace without expectedUpdatedAt is written', async (t) => {
  const { docmost, server } = await startHarness(t, [page()]);

  const result = await server.call('update_page', { pageId: 'p1', markdown: 'new body' });
  assert.equal(result.isError, false);
  assert.deepEqual(docmost.writes()[0]?.body, {
    pageId: 'p1',
    content: 'new body',
    operation: 'replace',
    format: 'markdown',
  });
});
