import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePage } from './fake-docmost.ts';
import { startHarness } from './helpers.ts';

const editPage = async (t: Parameters<typeof startHarness>[0], markdown: string, args: Record<string, unknown>) => {
  const { docmost, server } = await startHarness(t, [makePage({ id: 'p1', markdown })]);
  const result = await server.call('edit_page', { pageId: 'p1', ...args });
  return { result, docmost, written: docmost.writes().map((write) => write.body.content) };
};

test('a unique match is replaced and the rest of the body is kept', async (t) => {
  const { result, written } = await editPage(t, 'alpha\n\nbeta\n\ngamma', { oldText: 'beta', newText: 'BETA' });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.text).replacements, 1);
  assert.deepEqual(written, ['alpha\n\nBETA\n\ngamma']);
});

test('text that is not on the page is refused and nothing is written', async (t) => {
  const { result, written } = await editPage(t, 'alpha', { oldText: 'missing', newText: 'x' });
  assert.equal(result.isError, true);
  assert.match(result.text, /oldText not found in Page p1; re-read the page with get_page/);
  assert.deepEqual(written, []);
});

test('text found 3 times is refused without replaceAll', async (t) => {
  const { result, written } = await editPage(t, 'x and x and x', { oldText: 'x', newText: 'y' });
  assert.equal(result.isError, true);
  assert.match(result.text, /oldText appears 3 times; include more surrounding text or set replaceAll/);
  assert.deepEqual(written, []);
});

test('replaceAll replaces every match', async (t) => {
  const { result, written } = await editPage(t, 'x and x and x', { oldText: 'x', newText: 'y', replaceAll: true });
  assert.equal(JSON.parse(result.text).replacements, 3);
  assert.deepEqual(written, ['y and y and y']);
});

test('an empty newText deletes the text', async (t) => {
  const { written } = await editPage(t, 'keep this, drop this', { oldText: ', drop this', newText: '' });
  assert.deepEqual(written, ['keep this']);
});

test('regex characters in oldText match literally', async (t) => {
  const { written } = await editPage(t, 'costs $5.*[x](y)? today', { oldText: '$5.*[x](y)?', newText: '$6' });
  assert.deepEqual(written, ['costs $6 today']);
});

test('Windows line endings in oldText and newText match the page', async (t) => {
  const { written } = await editPage(t, 'line one\nline two', { oldText: 'line one\r\nline two', newText: 'one\r\ntwo' });
  assert.deepEqual(written, ['one\ntwo']);
});

test('a table with a header row keeps a single header row after an unrelated edit', async (t) => {
  const exported = '|  |  |\n| --- | --- |\n| a | b |\n| 1 | 2 |\n\nanchor';
  const { written } = await editPage(t, exported, { oldText: 'anchor', newText: 'ANCHOR' });
  assert.deepEqual(written, ['| a | b |\n| --- | --- |\n| 1 | 2 |\n\nANCHOR']);
});
